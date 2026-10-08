# The character-performance foundation (wave 14, "Wardrobe", step 0/1)

The standing goal, the user's words (2026-09-28 and every wave since): **at least 60 fps**. Gate G1: WebGPU and WebGL2
Medium, p95 under 16.7 ms, on any GPU vendor (AMD, NVIDIA, Apple). This wave's own asks, verbatim:

> All npc's walking around town should not have all same gears players have. Thats weird and boring.

> Is it possible to add physics to the clothings? Especially garmet since is supposed to be a garmet.

> create more clothing's

> Clothing dyes, so the new gear and civilian clothes can be recoloured.

Cloth, hair and more clothing all cost per character. Today twenty players at the plaza already sit at the G1 line
(wave11/budgets.md, "Rescue re-bench"). So this spec does the character part of the final performance pass first, as
the wave's foundation: **make player characters and monsters cheap**, with room left for cloth (docs/CLOTH.md) and,
later, hair.

**Numbering.** The user swapped the two next waves (2026-10-03: "Lets make wave 15 actually wave 14, and current wave
14 make it wave 15"). **Wave 14 is now Wardrobe** (this spec, docs/CLOTH.md, docs/WARDROBE.md). **Wave 15 is The
Climb** (docs/CLIMB.md and docs/WAVE_PLAN10.md still call it wave 14 until the wave plan renumbers them). CLIMB §4.3's
named gear slots keep their ids **W15-A..D**: they are ids, not wave numbers.

**What this spec builds, in one paragraph.** Characters get **three tiers**. **T0** is your own character. **T1**
("near") is your target, your party and the few nearest people on screen, capped at Medium 4, High 6, Ultra 12. Both stay
exactly as today: Babylon skinned meshes with a live skeleton, crossfades, arm layers and, from this wave, cloth.
**Everyone else is T2, "the crowd"**: other players, NPCs and monsters at any distance. T2 is drawn the way the
wave-11 townsfolk are drawn. Their animation is baked into a **bone-matrix texture (VAT)**, and each outfit (all the
worn parts of a character merged into one mesh that reads a shared texture array) is drawn **once for everyone wearing
it**, through thin instances. A T2 character has no Babylon skeleton, no animation groups, no meshes of its own and no
per-frame skin upload: the CPU writes one matrix and one clip row per character per frame. The prototype runs the crowd
tier **inside the real game page**, on the real 20-player scenes: with every other character in it, the 20-player
plaza drops from 21.9 to 13.8 ms p95 on WebGPU Medium and the 20-player Tiger Girl fight from 27.6 to 15.0, measured
interleaved on one page (−37 % and −46 %; WebGL2 −34 % and −32 %); with the Medium near set kept skinned, 15.4 and
16.8. The machine was busy that day and read ≈ 1.6× the last gate, so on the gate's machine state that is ≈ 9.5 ms for
the plaza and ≈ 10.4 ms for the fight [projected], under the task's 12 ms target.

**The user delegated every decision.** Each choice is the option this spec would mark "(Recommended)", written as a
decision with a one-line reason (§17). Only what truly needs the user is in §18 and §19, each with the default used.

**Tags:**

- **[confirmed]**: measured by this spec's scripts or read in the code or data of the working tree on 2026-10-03. Each
  one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes.

**Repo state** [confirmed: `git log -1`, `git status`]: HEAD `9629429` (the mini-wave: rain, GM teleports, WASD, the
new dragon, god rays), clean tree. This spec edits nothing in `packages/`, `apps/`, `content/` or `deploy/`. Its
scratch is all in `work/tmp/charperf/` (Appendix A): the bench tools, two production bundles of HEAD, the prototype
(`tools/vatproto.js`) and the results. No Meshy credits were used. No downloads.

**Sources read:** docs/WAVE_PLAN10.md (the format), CHARACTER_SCALE.md, TOWN_LIFE.md (§3.2 the VAT crowd, §8, §11),
SYSTEMS_COMBAT.md (equipment), ASSETS.md, UI.md (the label layer), BACKLOG.md item 9, CLOTH.md (the sibling), RENDER.md,
`wave11/budgets.md` (the rescue re-bench), `work/tmp/w11-rescue/bench.md` (the rescue's profile), `wave12/budgets.md`.
Code: `apps/game/src/three/models.ts` (CharacterActor, ModelLibrary, ANIM_LOD, `mergeSkinnedParts`),
`apps/game/src/world/{crowd-budget, entities, nameplates}.ts`, `apps/game/src/screens/world.ts`,
`packages/world-render/src/town/crowd.ts` (the VAT crowd), `packages/world-render/src/render/shadows.ts` (casters,
cascade limits, caster sources), `packages/convert/src/town/{vat, variants}.ts` (the VAT baker),
`apps/game/src/engine.ts`.

---

## 0. Summary

| Question | Answer |
|---|---|
| Where does the 20-player time go today? | **The other characters are 54 % of the plaza's frame** (10.0 of 18.5 ms p50), and it is **drawing them**, not animating them: Babylon's per-mesh evaluation, the per-draw submission and the shadow passes for ≈ 6 parts × 20 players + 20 monsters + 19 NPCs. With their clips running but nothing drawn the frame is at the floor (§1.3). The GPU idles (2.6 ms of a 19 ms frame) |
| The biggest single win | **The crowd tier**: other characters drawn as thin instances with a baked bone-matrix texture, the townsfolk's path generalised. Prototyped in the real game page: **plaza 21.9 → 13.8 ms, fight 27.6 → 15.0 / 24.5 → 13.3 (WebGPU Medium p95), WebGL2 15.9 → 10.5 and 17.4 → 11.8**; frames over 16.7 ms from 247–379 of 400 to 0–4 at the plaza and from 305–388 to 0–30 in the fight (§11) [confirmed, interleaved; busy machine] |
| The design | **Three tiers** (§2): T0 your character and **T1 the few you look at** (target, hover, party, nearest on screen, **capped** at Medium 4, High 6, Ultra 12) stay exactly as today, with cloth; **T2 everyone else** at any distance is the crowd: **one draw per outfit** (a merged outfit mesh reading the crowd texture arrays), instanced over everyone wearing it, a per-skeleton VAT with row interpolation, a crossfade and the arm layer (`SroCrowdSkin`), weapons as bone slots, no Babylon skeleton or animation groups (a clip clock), the same pose when moving between tiers |
| GPU skinning paths | Babylon GPU bones for T0/T1, VAT + thin instances for T2; compute skinning, workers and impostors rejected (§3) |
| Part merging | T1: the rescue's merge + frozen materials; **T2: one draw per outfit**, because per-part instancing loses most of its gain when twenty players wear twenty outfits (19.6 vs 12.7 ms, §4.2) |
| Animation LOD | T2 needs none (the GPU reads a row); the per-actor loops left (`blending()` over 75 groups, `EntityView.update`, label anchors) are trimmed (§5) |
| Shadows | T2 casts into cascade 0 (Medium), 0–1 (High): ≈ 0.25 ms for 59 characters; on Medium the rescue's blobs **stay** for T2 characters beyond cascade 0 (≈ 11.5 m from the camera), as in the measured runs (§6) |
| Identical monsters | T2 by default: a nest of twenty is one draw (§7) |
| GC | the other characters are ≈ 49 % of the plaza's allocation (0.74 vs 0.38 MB a frame without them); T2 removes ≈ 40 % (0.74 → 0.45); the fight's rest is effects [likely] (§8) |
| Name tags | the DOM side is ≤ 1 ms; the JS side is trimmed (15 Hz far labels, no string per label per frame) (§9) |
| Budgets | **20-player plaza ≤ 12 ms and the fights ≤ 13 ms p95 on WebGPU Medium**, ≤ 9 / ≤ 10 on WebGL2, measured on a quiet machine; projected ≈ 9.5 / ≈ 10.4 (§10) |
| Room for cloth and hair | ≈ 1.5–2.5 ms under the 12 ms target on Medium at the plaza after the foundation; cloth needs ≤ 0.35 ms (§10.3). **High's 20-player fight is at the line with cloth** (≈ 16.2 ms projected with D23's T1 of 4): D23's second step (T1 2) covers it (§10.1) |
| Cost of the build | ≈ 13 agent-days: one seam agent, five lanes, integration (§13) |


### 0.1 Where each part of the task lands

| The task asked for | Where |
|---|---|
| Profile first: the 20-player plaza and the 20-player Tiger Girl fight, quiet machine | §1 |
| GPU skinning paths: Babylon's GPU bones vs baked animation textures | §3 |
| Part merging: one draw per material per character, or per character | §4 |
| Animation LOD and update throttling beyond the wave-11 rescue | §5 |
| Shadow-caster budgets | §6 |
| Instancing identical monsters | §7 |
| Per-frame allocation and GC cuts | §8 |
| Name tags and HUD cost | §9 |
| Budgets with targets (20-player plaza ≤ 12 ms p95 WebGPU Medium) | §10 |
| The prototype: the biggest single win, measured in a scratch page, shots and numbers | §11, `work/tmp/charperf/` |
| Headroom for cloth and hair | §10.3, §12 |

### 0.2 Fact-check (2026-10-03, an adversarial pass over this spec)

Every measured number in §1 and §11 was re-derived from the raw runs (`shots/cp_*.json` through `tools/cp_table.py`,
plus the GPU and over-16.7 columns); the gate references from `work/night/NIGHT_LOG.md` (the mini-wave gate:
5.8 / 4.1 empty plaza, 12.7 / 8.4 twenty-player plaza) and `wave11/budgets.md`; the code claims in `models.ts`,
`crowd-budget.ts`, `shadows.ts`, `entities.ts`, `town/crowd.ts`, `convert/src/town/vat.ts`; the data claims in
`work/out*/equipment/equipment.json`, the character glbs and the animation packs. They hold, except what this pass
corrected in place:

1. **Medium blobs** (§6.2, D11): the measured runs **kept** the rescue's blobs (`vatproto.js`: "game logic keeps running
   (clips, state, labels, blobs)"; `vatnocast` = "blobs only"). Medium's cascade 0 ends ≈ 11.5 m from the camera
   [projected: `csmSettings` λ 0.7, maxZ 60, camera minZ 0.2, Babylon's split formula], so removing the blobs would
   leave most T2 characters with no shadow at all. The blobs stay beyond cascade 0.
2. **T1 and parties** (§2.1, D2): a party holds up to 8 (`PARTY_MAX`, `shared/protocol.ts`), so "party always T1" could
   put 7–9 skinned characters on Medium. The preset count is now a hard cap that includes party, target and hover.
3. **Cloth's look for T2** (§2.5, D10, §12): CLOTH decides that non-simulated wearers wear the **plain glb** (CLOTH §6.5,
   F1, CL-D11); the re-weighted "crowd skin" and its `rigs.json` dependency were redundant and are dropped. CLOTH's two
   "warm" actors need a live skeleton, so they occupy T1 slots.
4. **VAT size** (§2.5, §10.2, D7): the 3,833 rows the prototype baked are the **default** pack (76 clips, 132.7 s); a
   family adds its pack (sword 41 clips 91 s, spear 54 clips 125 s, bow 34 clips 56 s). At 20 rows/s for skills the
   spear VAT would pass the baker's 4,096-row cap (`VAT_MAX_FRAMES`); at 15 rows/s a (gender, family) VAT is
   ≈ 3–6 MB, not 3.5, and a 20-friend town can hold up to 8 at once (≈ 35 MB, not ≤ 16).
5. **Dyes in T2** (§2.3, §12): WARDROBE D34 needs a dye per piece, not one triplet per character; with one batch per
   outfit the equipment slot must be per vertex. Adopted.
6. **New sets in the array** (§2.3): retail textures are small (69 at 128², 36 at 256², 15 at 512², 7 at 64 × 128
   [confirmed: the 127 equipment PNGs]), so 256² layers lose detail on 15 only; but WARDROBE's sets share one 1024²
   atlas for six pieces, which a 256² layer would blur 4×. Atlas sources get a second 512² array.
7. **One pipeline per outfit** (§2.3): 27 equipment materials are double-sided and the bodies and hair are alpha-tested
   (MASK) [confirmed: the glbs]; the converter writes double-sided parts with both windings so one cull state serves
   all. The per-vertex and per-instance data must be **interleaved**: the townsfolk already use 5 vertex + 3 instance
   buffers = WebGPU's 8 (`crowd.ts` 467–469), and Babylon merges only attributes that share one GPU buffer
   (`webgpuCacheRenderPipeline.js` `_CanMergeVertexBuffer`). The crowd material is at 15 of 16 inter-stage variables
   (WARDROBE §7.3, `material-budgets.test.ts`): the layer index and dye slot share one flat varying.
8. **T2 must not disable the actor root** (§2.3, §11.1): the prototype did; the root carries the NPC pick box
   (`entities.ts` `fitModelPick` parents it to `actor.root`), auras and attachments. T2 disables the drawn parts only.
9. **Off-screen T2** (§2.3, §5.2): "not written" contradicted "still casts" and the matrix-write LOD; slots are now
   stable and only characters outside both the view and the caster range leave the buffer.
10. **Shadow pose** (§2.3): Babylon's CSM draws with its own depth shader, so `SroCrowdSkin`'s interpolation, crossfade
    and volume would be missing from the shadows; the crowd material gets a `ShadowDepthWrapper` (the foliage plugin's
    pattern).
11. **High** (§10, D23): the High fight is ≈ 16.2 ms with cloth [projected], over its 16.0 target; D23 gets a second
    step. WebGL2 High was not measured: added as [unknown] with a projection.
12. **Apple** (§3.3): the frame is CPU-bound, so "any vendor" is mostly a CPU question; an M1's single thread at
    ≈ 0.7× the dev PC puts the plaza at ≈ 13–14 ms [projected], under the line, over the 12 ms target.
13. Numbers: High `Hi6` plaza `base` 27.9 (27.7–32.5), not 27.7 (the sheet PNG still prints 27.7); the "both WebGPU
    pages" of `freeze` / `tagsoff` include one discarded page (`M`, interleaved, so its differences stand); the fight's
    × 0.62 check compared a first fight with the rescue's later fights (now against LAB-12's first fights).
14. Riders (§2.1): players ride horses (`attachTo` the saddle joint, `models.ts` 2267); a ridden pair in T2 was never
    prototyped; the rule is now written down.

No download and no Meshy credit was used by this pass; nothing was re-timed (no number looked off against its raw run).

---

## 1. Today: the profile [confirmed unless tagged]

All numbers on this page: the dev PC, 1920 × 1080, Medium, p95 of the frame time, the median of 3 interleaved runs
(§16). **Read them as ratios.** The machine was never quiet during this spec (§16): it read ≈ 1.6× the mini-wave
gate's frame times on the same scenes (the empty plaza at noon 9.3 ms vs the gate's 5.8; the 20-player plaza 21.9 vs
12.7), so today's absolute numbers are high, but every variant of a scene ran interleaved on the same page and the
same minutes, so the differences hold [confirmed: the spreads in the tables]. Absolute numbers "at the gate's machine
state" are today's × 0.62 [projected: 5.8 ÷ 9.3; it reproduces the gate's 20-player plaza within 7 %: 21.9 × 0.62 =
13.6 vs 12.7 measured (the plaza's own ratio is 0.58, so 0.62 is the cautious choice). The fight has no mini-wave gate
row: 27.6 × 0.62 = 17.1 sits inside LAB-12's first fights (16.9 / 19.0) and above the wave-11 rescue's first fights
(14.0–15.0), so a fight projection may be up to ≈ 2 ms optimistic (LAB-12's 19.0 page) or ≈ 2 ms pessimistic]. The empty plaza read 12.0 at the end of
the `H` page against 9.3 on a fresh one: pages slow down with their history (as wave 11 found), another reason to read
only interleaved differences.

### 1.1 The two scenes today (HEAD `9629429`, WebGPU Medium) [confirmed: `shots/cp_webgpu_medium_H.json`]

| Scene | p95 (spread) | p50 | Frames over 16.7 ms (of 400) | Draws | GPU (timestamp sum, p50) | At the gate's state [projected] |
|---|---|---|---|---|---|---|
| Plaza: 20 Mangnyang + 20 jumping players + the town | **21.9** (19.6–22.0) | 18.5 | 247–379 | 355 | 2.6 ms | ≈ 13.6 (the gate: 12.7) |
| Tiger Girl, 20 attackers, camp 5906 (first fight) | **27.6** (22.2–28.1) | 19.3 | 305–388 | 303 | 1.7 ms | ≈ 17.1 |
| Tiger Girl, 20 attackers, camp 5659 (second fight on the page) | **24.5** (23.9–26.2) | 19.3 | 358–388 | 326 | 1.7 ms | ≈ 15.2 |
| The empty plaza at noon (calibration; fresh page / end of page) | 9.3 / 12.0 | 7.6 / 9.6 | 0–15 | 209 | 2.0 ms | 5.8 (the gate) |

WebGL2 Medium (`shots/cp_webgl2_medium_L.json`): the plaza 15.9 ms p95 (15.8–16.2) [p50 13.0], Tiger Girl at 5906 17.4
(16.6–18.2), the empty plaza 8.8 (the mini-wave gate on WebGL2: 8.4 for the 20-player plaza, 4.1 for the empty plaza).

The frame is **CPU-bound**: the GPU's whole frame is 1.7–2.6 ms of a 19–28 ms frame, as in every gate since wave 9.

### 1.2 What the plaza scene holds [confirmed: `C.census()` in the page]

61 actors: 21 players (the 20 bots and one harness character), 20 Mangnyang, 19 NPCs, and the bench character.
2,097 meshes, 124 skeletons, **2,048 animation groups, 4,422 running animatables, 6,431 transform nodes**. A player
(the starter outfit and sword) is 8 drawn parts (6 after the rescue's merge), one 43-bone skeleton with a bone
texture, **75 animation groups** (86 tracks each for the base clips) and 211 nodes, 1,237 vertices. A Mangnyang is one
merged mesh with 2–4 groups (more load on its first attack). All bots share one material and geometry object per part
(the glb container's).

### 1.3 Where the time goes (knobs on the live page, the plaza) [confirmed]

| Variant (what changes for the 59 other characters) | p95 | p50 | anim | logic | active-mesh eval | shadows | main pass | draws |
|---|---|---|---|---|---|---|---|---|
| **base** (as today) | 21.9 | 18.5 | 2.11 | 1.36 | 4.61 | 1.48 | 7.13 | 355 |
| **hidepause**: not drawn, not animated (the floor) | 10.5 | 8.5 | 1.58 | 1.11 | 1.35 | 0.67 | 2.50 | 119 |
| **hide**: not drawn, clips still running | 10.9 | 8.8 | 1.72 | 1.15 | 1.38 | 0.69 | 2.59 | 121 |
| **freeze**: their materials frozen | 20.5 | 17.4 | 2.17 | 1.35 | 4.46 | 1.47 | 6.29 | 355 |
| **tagsoff**: the label layer `display: none` | 20.6 | 17.6 | 2.20 | 1.30 | 4.47 | 1.47 | 6.99 | 354 |
| **vat**: the crowd tier (§11) | 13.8 | 10.8 | 0.78 | 1.31 | 1.77 | 0.95 | 4.74 | 191 |

(segment columns: mean ms per frame, `prof.js`)

- **The other characters are 54 % of the frame**: 10.0 of 18.5 ms at p50 (base − hidepause).
- **It is the drawing, not the animation**: with the clips still running but nothing drawn (`hide`) the frame is within
  0.3 ms of the floor. The rescue's animation LOD already made the clips cheap; what is left is Babylon's per-mesh
  work: the active-mesh evaluation (+3.3 ms: world matrices, the skeletons' `prepare` and bone-texture upload for
  every drawn skinned mesh, bounds, `isReady`), the main pass's per-draw submission (+4.6 ms), the shadow passes
  (+0.8 ms).
- **Per character** (p50): an average other character costs **0.17 ms**; a skinned player kept near (T1, the `vat4`
  row of §11.2: four more skinned players than `vat`) **0.53 ms**; a character in the crowd tier **0.039 ms**
  (vat − hidepause over 59 characters, the prototype's 5 Hz Babylon clips included).
- **Frozen materials**: the main pass −0.8 ms on both WebGPU pages (`H` 7.13 → 6.29; the discarded page `M` 7.20 →
  6.39, its variants interleaved, so the difference stands even though its absolutes were discarded), the frame
  −1.1 / +0.2 ms at p50: a small, real saving on the main pass, inside the noise at p95 (§4.1 keeps it as a cheap cut).
- **Name tags**: −0.9 / −0.2 ms at p50 with the layer hidden (`H` / the discarded `M`): the DOM cost of 60 labels is
  small; their JS cost stays in "logic" (§9).

### 1.4 The JS profile (unminified build, relative shares) [confirmed: `shots/prof_plaza_{base,vat}.json`; taken while the machine was busy, so shares only]

- **Today**: the render loop 89 % of the samples. Inside: the main and shadow draws (`_RenderSorted`, `bindForSubMesh`,
  `drawElementsType`) ≈ 41 %; `_evaluateActiveMeshes` 21 %; animations 8 % (`_animate` via `lodAnimate`); the
  skeletons' `prepare` 6.7 %; the shadow map 4.3 %; WebGPU `writeBuffer` (uniforms, bone textures) 3.5 % self.
- **With the crowd tier**: `_prepareSkeleton` disappears from the profile, `_evaluateActiveMeshes` drops to 15 %,
  animations to 5 %; the draws are the bulk of what is left (the town, the terrain, the instanced batches). The new
  small items in the list are the actors' own per-frame loops: `blendingOwn` (0.9 % self: it walks all 75 groups of a
  player every frame, §5.2) and `labelAnchor` (0.8 %).

### 1.5 Allocation and GC [confirmed: `allocMBps`, `gcDrops` of every run]

| Scene | Variant | MB allocated per frame | Heap drops ≥ 0.5 MB per 400 frames |
|---|---|---|---|
| Plaza | base / vat / hidepause | 0.74 / 0.45 / 0.38 | 11 / 7 / 5 |
| Tiger Girl 5906 | base / vat | 1.29 / 0.92 | 19 / 15 |
| Tiger Girl 5659 | base / vat | 1.11 / 0.73 | 18 / 12 |

The other characters are ≈ 49 % of the plaza's allocation (base − hidepause = 0.36 of 0.74 MB) and the crowd tier
removes ≈ 40 % (0.29 MB; the prototype's 5 Hz clips keep the rest); the fight's remaining ≈ 0.9 MB a frame is mostly the
effects (hits, skills, damage numbers) [likely: the rescue's profile found the same; not profiled here].

---

## 2. The design: three tiers [decision]

### 2.1 Who is in which tier

| Tier | Who | How it is drawn | What runs on the CPU per frame |
|---|---|---|---|
| **T0** own | your character | as today: skinned glb parts, a live skeleton (Babylon GPU bones: the bone matrices in a texture), every frame | clips, the skeleton, the bone-texture upload, cloth (CLOTH §6) |
| **T1** near | **at most the preset count: Medium 4, High 6, Ultra 12** (so with T0: 5 / 7 / 13; CLOTH's simulated and warm actors are these, §12), filled in this order: your target and the hovered character (always in, they need the outline and the ring), then party members **on screen within 20 m** by distance, then the nearest others on screen within 20 m. A party holds up to 8 (`PARTY_MAX`), so party members beyond the cap stay T2 (their party frames and HP bars need no skeleton) | as today, with the rescue's merged parts and frozen materials (§4.1) | clips at the rescue's rates (full within 15 m), the skeleton, the upload, cloth |
| **T2** crowd | **everyone else**: other players, NPCs, monsters, pets and horses; any distance, on screen or off | **one outfit batch** (its worn parts merged into one mesh reading the crowd texture array, §2.3) thin-instanced over everyone in that outfit, skinned from a baked bone-matrix texture; monsters and NPCs one batch per model | one 64-byte matrix and a 16-byte clip write per character; nothing else |
| (Low / Classic) | everyone | **unchanged** (the Low guard): no tiers, no VAT, no merge, today's files | as today |

- **Why T1 is small** [confirmed: §1.3, §11.2]: a skinned character kept near costs ≈ 0.53 ms of CPU at p50 and a T2
  character ≈ 0.04 ms. Keeping the 4 nearest players skinned costs 1.6–3.4 ms at p95 on WebGPU Medium; keeping 9 on
  High costs ≈ 7 ms. So the near set is what cloth needs on Medium (CLOTH §6.5), and smaller than CLOTH asked on High
  and Ultra (§12).
- **Rank** (every 250 ms, the crowd budget's existing plan): own (T0), target, hovered, party, then by camera distance
  among those on screen within 20 m; the cap counts all of them [decision: an uncapped party could put 7–9 skinned
  characters on Medium, ≈ 2.3–3 ms at the gate's state]. **Hysteresis**: a T1 character keeps its slot until a T2 one
  is 3 m nearer, and a change of tier happens at most once a second per character (target and hover excepted: they
  promote at once and may push the farthest T1 out).
- **Riders** (players on horses: the rider's root is attached to the horse's `saddle` joint, `models.ts` `attachTo`):
  the pair moves between tiers together and counts as one slot. In T2 the horse is a model batch whose VAT carries the
  saddle joint as a socket slot, and the rider's instance matrix is the horse's matrix × that socket (the sockets' CPU
  copy, the same clip clock) [decision; not prototyped: the prototype skipped every rider pair; CP-A's test checks the
  rider stays seated within 1 cm over the horse's walk, run and stand].
- **Monsters** go to T1 only as your target (or a ridden unique composite: Tiger Girl and her Blue Tiger stay T1
  together, UNIQUES D-U22; they are outside the cap, as are bosses). Every other monster is T2: twenty Mangnyang are one
  draw (§7).
- **Uniques and bosses** (Tiger Girl, the Qilin, the Tomb's bosses in wave 15): T1 always (they are few, big, and
  carry effects on bones).

### 2.2 Moving between tiers without a pop

- **T2 → T1 (promotion):** the actor builds what T1 needs, at most **two promotions per frame** (a skeleton, its
  animation groups, its merged parts). The new skeleton is posed at the T2 clip's current time before its first draw:
  the T2 clock knows the clip and the time (§2.4), so the first T1 frame shows the same pose. The thin instance is
  removed in the same frame. [decision; the prototype swaps both ways with the same pose, §11.1]
- **T1 → T2 (demotion):** the opposite, and the actor's animation groups and skeleton are **released** after 10 s in
  T2 (a re-promotion within 10 s reuses them).
- **Lazy animation groups.** Today every player actor instantiates all its clips at creation: 75 animation groups (86
  tracks each
  for the base clips) and 211 nodes per player [confirmed: census, §1.2]. A T2 actor never needs them. They are created
  on the first
  promotion. Actor creation gets cheaper too, which helps the region-entry hitch (H11-HI-3) [likely].

### 2.3 What a T2 character looks like (the crowd renderer)

- **Outfits, not parts** [decision; measured, §11.2]. A T2 character is drawn by its **outfit batch**: one mesh with
  all its worn parts (body pieces, garments, hair, weapon, shield) concatenated, drawn with **one material** that reads
  each vertex's texture from the **crowd texture array** (every wearable item's and body's albedo at 256 × 256, one
  layer each; the vertex carries its layer index). Characters in the **same outfit share the batch** through thin
  instances, so twenty identical bots are one draw and twenty different outfits are twenty draws, never 6 × 20.
  The prototype measured why: instancing **per part** (6 draws per distinct outfit) wins big when everyone wears the
  same thing, but with twenty different outfits it is almost no better than today; the one-draw-per-outfit proxy is as
  fast as the best case (§11.2, `unique` vs `unique1`).
- **The crowd texture array** [projected from `equipment/equipment.json`: 456 Chinese items use 126 glbs and 127
  images; the 26 Chinese bodies add ≈ 60 (body, hair)]: ≈ 190 layers, 256² BC7/ASTC (1 B/texel) + mips ≈ 87 KB each
  ≈ **16.5 MB** VRAM for both genders (split per gender: ≈ 8 MB each, loaded with the first T2 character of that
  gender; ≈ 95 layers each, under WebGL2's and WebGPU's 256-layer minimum). The retail sources are small: of the 127
  equipment textures 69 are 128², 36 are 256², 15 are 512² and 7 are 64 × 128 [confirmed: the PNGs in `work/out`;
  the game loads them as WebP inside the glbs], so a 256² layer loses detail on 15 textures only. The array is KTX2
  through `texture-compressed.ts`'s per-layer compressed-array upload (the terrain arrays' path: ASTC, then BC7, RGBA8
  as the fallback at 4× the memory) [confirmed: the module exists for exactly this]. **Atlas sources** (WARDROBE's new
  sets share one 1024² atlas for six pieces, WARDROBE §4.6) would lose 4× in a 256² layer, so they go into a **second
  array at 512²** (2× down, ≈ 349 KB a layer; ≈ 18 atlases ≈ 6.3 MB [projected from WARDROBE's sets]); the vertex's
  layer index carries the array bit [decision: the T2 player next to you must not look blurrier than the retail
  items]. **Dye masks** (WARDROBE §7) are layers too: one mask layer per dyeable texture in a mask array of the same
  sizes. The bodies and hair are alpha-tested (glTF `MASK`: 52 of the 54 character materials; the equipment is mostly
  `OPAQUE`, 9 of 132 `MASK`) [confirmed: the glbs], so the whole batch draws alpha-tested (an opaque item's layer reads
  alpha 1) in the alpha-test queue (early-z is lost for these ≈ 1,200-vertex meshes, a negligible cost
  at their size). The remaster's character maps (BACKLOG's B4 batch) add a normal/ORM array later.
- **The crowd mesh of an item** (converter, CP-V): each item's (and body part's) mesh rewritten in **one vertex layout
  for all** (position float32, normal and UV 16-bit, joints remapped to the skeleton's order, weights, the layer index)
  so the client builds an outfit by **concatenating** the parts' crowd meshes (a memcpy per part, ≈ 1,200 vertices per
  outfit) when a new outfit first appears in T2; outfits are cached by their worn-item key and dropped 60 s after their
  last instance [decision]. One layout = one render pipeline for every outfit, which needs three more things
  [decision, fact-check §0.2 item 7]:
  - **one cull state**: 27 equipment materials (and two hair materials) are double-sided [confirmed: the glbs]; the
    converter writes a double-sided part with both windings (back faces flipped, normals negated), so the batch draws
    with back-face culling on;
  - **interleaved buffers**: all per-vertex data in one GPU buffer and all per-instance data except the matrix in one
    more (Babylon's WebGPU path merges only attributes that share a buffer, `_CanMergeVertexBuffer`); separate buffers
    would be 6 vertex + 5 instance = 11, over WebGPU's 8 (the townsfolk are at 8 already: 5 vertex + `matrix`,
    `bakedVertexAnimationSettingsInstanced`, `color`) [confirmed: `crowd.ts` 467–469; WebGPU's default
    `maxVertexBuffers` is 8]; attributes stay ≤ 16 for WebGL2;
  - **one flat varying** for the layer index, the array bit and the dye slot: the crowd material uses 15 of 16
    inter-stage variables already (WARDROBE §7.3, `material-budgets.test.ts`); CP-R adds a "player crowd" row to that
    guard.
- **Rigid parts** (weapons, shields, hats fixed to a bone) are skinned to **one extra bone slot** in the VAT (the
  socket's matrix per frame), so they move with the hand exactly [confirmed: the prototype's swords, §11].
- **Monsters and NPCs** need no array: their parts already share one or two materials; their batch is the model's
  merged mesh (the rescue's merge), instanced.
- **The VAT** (§2.5): one texture per skeleton and clip set, half-float, 30 rows per second; the batch's vertex shader
  reads 4 texels per bone influence (Babylon 9.28's `bakedVertexAnimation` include, the same path as the townsfolk).
- **Our VAT plugin, `SroCrowdSkin`** [decision], instead of Babylon's `BakedVertexAnimationManager` settings, because a
  character needs three things the townsfolk did not:
  - **row interpolation**: two rows, lerped by the fraction, so a 30 rows/s bake is smooth at 144 Hz and slow clips do
    not step (the townsfolk accept the step at 60 m);
  - **a crossfade**: the instance carries the previous clip and a blend weight for the clip-change blend (0.08 s base,
    0.25 s moves: `BASE_BLEND`, `MOVE_BLEND_IN`), so a T2 character never snaps between clips;
  - **an upper-body layer**: the arm layer (`armLayerSides`: a weapon held while running) as a per-bone mask in the
    VAT row's alpha of a second clip, the same two-clip read.
  The cost is GPU only: 8–16 texel fetches per influence instead of 4. The GPU is idle in these scenes (1.3–1.6 ms of
  a 15 ms frame, wave11/budgets.md) [confirmed]; §10 caps it.
- **Body volume** (CHARACTER_SCALE E9: `setSkeletonVolume` scales 7–8 bones radially, Volume 0–4 in whole steps)
  [confirmed: `models.ts` 770–800, `appearance/scale.ts`]: the skin matrix becomes `invBind × S × world`, which a
  VAT row (`invBind × world`) cannot express by itself. So T2 carries the **Volume step** (0–4) per instance, and the
  plugin multiplies by a per-bone correction `invBind × S × invBind⁻¹` read from a small texture (5 steps × 45 bones ×
  4 texels per gender), only for the bones that have one [decision]. Default Volume (2) costs nothing.
- **Per-instance data**: the world matrix (64 B, its own thin-instance buffer), then one interleaved 48 B record:
  clip A (rows, time, rate) and clip B with the blend weight (32 B), the **dye row** (WARDROBE D34: an index into a dye
  table texture holding 8 slots × 3 channels per dyed character, rewritten only on a dye or tier change; monsters'
  elite and nemesis tints are rows of the same table), the fade alpha and highlight (the `SroTownFadePlugin` colour's
  role) and the Volume step (16 B). A dye is per piece, so the **equipment slot is per vertex** in the outfit mesh
  (packed with the layer index; WARDROBE's "batch uniform" cannot work once the parts share one batch) [decision,
  fact-check §0.2 item 5]. One outfit batch per character means **one instance write per character** (the prototype,
  with per-part batches, wrote the matrix once per part).
- **Off screen**: slots are **stable** per character within a batch (swap-remove when a character joins or leaves), so
  the matrix-write LOD (§5.2) can skip a write. A T2 character leaves the buffer only when it is outside both the main
  view and the caster range of the cascades it casts into; one off screen but inside that range stays and casts (§6),
  without a label or a clip-row update [decision; fact-check §0.2 item 9].
- **The actor's root stays enabled** in T2: only its drawn parts are disabled (and so skipped by Babylon's active-mesh
  evaluation and skeleton preparation). The root carries the NPC pick box (`entities.ts` `fitModelPick` parents it to
  `actor.root`), the auras and the attachments; the prototype disabled the whole root, which the build must not
  [decision; fact-check §0.2 item 8].
- **Shadows draw the same pose**: Babylon's CSM uses its own depth shader, which would skip `SroCrowdSkin`'s
  interpolation, crossfade, arm layer and volume. The crowd material sets a `ShadowDepthWrapper` (the foliage plugin's
  pattern, `pbr/foliage-plugin.ts`) so the casters run the plugin's vertex code [decision].
- **Effects, trails, labels**: anything that needs a bone position (a weapon trail's two points, a glow on a hand, a
  hit spark) reads it from a **CPU copy of the socket bones only** (≤ 6 bones per skeleton: both hands, head, spine,
  the two weapon tips), sampled from the same clip clock. The rescue's caps on others' trails (4 Medium) and glows
  (8 nearest) stay.
- **Picking**: unchanged (the pick proxies are separate meshes, `metadata.sroPickOnly`).
- **Hover, target, party**: become T1 at once (promotion), so outlines, highlights and the target ring keep their
  current code.

### 2.4 The clip clock (no Babylon animation in T2)

The actor's state machine (`play`, `playAction`, `playSkill`, `hurt`, `die`, `revive`, the moves) already decides
which clip plays and when. For a T2 actor those calls drive a small **clip clock** instead of Babylon animation groups:
`{ clip, startMs, rate, loop, prev, blendUntil }`. The clock fires the same end and event callbacks (a one-shot's end
resumes the base clip; JUMP's take-off and landing events, `moveEventTimes`) from timers on the library's clock, so
the game logic sees the same events as today. The prototype kept Babylon's groups ticking at 5 Hz only to read the
clip state; the build removes them for T2 [decision].

### 2.5 The crowd VATs (the converter)

- **What is baked:** for each skeleton (Chinese man 43 joints, Chinese woman 45, every monster and NPC model), the clips
  a T2 character can play. Players: per weapon family (none, sword/blade, spear/glaive, bow, plus the skill clips of
  that family), the base set (STAND1–3, WALK, RUN, ATTREADY, the attacks, DAMAGE, DIE, DOWN, SIT, PICK, EMOTION01–08,
  JUMP/JUMP_RUN, TURN_L/R) and every SKILL_* clip of the family. Monsters and NPCs: every clip they have.
- **Size** [confirmed: the prototype's bake of the bench character's 75 clips is 3,833 rows; those are the **default**
  pack's clips (`char/_anims/europeman_skel/default.glb`: 76 clips, 132.7 s), not a weapon family's; at half float for
  45 slots (43 joints, one socket, the identity row): 3,833 × 45 × 4 texels × 8 B = 5.5 MB]. A family's VAT holds the
  default pack's clips a T2 player can play (≈ 70 s once the vendor, Europe and qigong clips are left out) plus the
  family's pack: sword/blade 41 clips 91 s, spear/glaive 54 clips 125 s, bow 34 clips 56 s (the woman's packs:
  41 / 46 / 24 clips) [confirmed: the packs' clip durations]. The baker caps a VAT at **4,096 rows** (`VAT_MAX_FRAMES`,
  "WebGL2 guarantees 2,048, every target here does 4,096+") [confirmed: `town/vat.ts` 38]; at 30 rows/s for the base
  set and 20 for skills the spear family would need ≈ 4,600. So: **30 rows/s for the base set, 15 rows/s for skills and
  emotions** (§2.3's interpolation hides it), which keeps every family ≤ 4,096 rows (spear ≈ 3,975, the largest)
  [decision]: **≈ 3.0 MB (no weapon), 4.2 MB (bow), 5.0 MB (sword), 5.7 MB (spear) per gender** (+4 % for the woman's
  45 joints) [projected; fact-check §0.2 item 4]. Loaded **lazily**, per family, when the first T2 character of that
  family is seen: a solo session holds 2–4 (≈ 10–20 MB VRAM), a 20-friend town up to 8 (both genders × 4 families,
  ≈ 35 MB VRAM, ≈ 4 % of Medium's ≈ 900 MiB of textures; ≈ 2–4 MB download each after Brotli) [projected]. A family
  whose clips outgrow 4,096 rows later (Arsenal) splits its skills into a second texture (R3).
- **Cloth garments** (CLOTH §5): a T2 character wears the garment's **plain glb** (retail weights), as every non-simulated
  wearer does in CLOTH (§6.5, F1, CL-D11: "everyone else wears the plain glb"); its crowd mesh is built from that glb
  like any other item, with no extra bones in the VAT and no dependency on CL-R's `rigs.json` [decision; fact-check §0.2
  item 3: the earlier "re-weighted crowd skin" duplicated what the plain glb already gives].
- **The baker** exists: `packages/convert/src/town/vat.ts` (`bakeVat`, `skinMatricesAt`, half encoding, the 1 mm /
  3 mm tolerance tests). A new verb `crowd` writes `crowd/vat/<skeleton>@<family>.{bin,json}`, the socket table, the
  per-item crowd meshes and the arrays [decision]. Its TL-V size constant (`VAT_MAX_BYTES`-style, ≤ 2.5 MB for a
  townsfolk VAT) does not apply to player VATs; CP-V adds its own (≤ 7 MB each).

---

## 3. GPU skinning paths compared

### 3.1 What runs today [confirmed: code and census, §1.2]

Babylon's **GPU bones** path: per character and frame, the CPU evaluates every playing clip on the 43 joint nodes
(86 tracks for STAND1: rotation and translation; `Animatable._animate`, our pooled interpolation), copies the nodes into
the
skeleton's bones, multiplies the 43 bone matrices (`Skeleton.prepare`), and uploads them into the skeleton's float
texture (`writeBuffer`); the vertex shader then skins 4 influences per vertex from that texture. The rescue's
animation LOD skips all of it on skipped frames. The GPU part is cheap; the CPU part, plus the per-mesh work of 6–8
parts, is the cost.

### 3.2 The options

| Path | CPU per character per frame | GPU | Crossfade, layers | WebGL2 / Apple | Verdict |
|---|---|---|---|---|---|
| **A. Babylon GPU bones** (today) | clips + node sync + 43 matrices + the texture upload, and 6–8 meshes' evaluation and draws (§1.3) | 4 fetches per influence | yes (Babylon's blending, our arm layer) | yes | **T0/T1** [decision] |
| **B. VAT + thin instances** (the townsfolk path, extended) | a 64 B matrix + 16 B clip write; no meshes of its own | 4 fetches per influence (8–16 with interpolation and crossfade) | yes with `SroCrowdSkin` (§2.3) | yes: half-float RGBA textures are core WebGL2 and core WebGPU; vertex texture fetch everywhere [confirmed: the townsfolk run on both backends] | **T2** [decision] |
| C. Compute-shader skinning (WebGPU) | the same clip evaluation as A (the CPU still animates) | a compute pass + a skinned vertex buffer per character | as A | **no on WebGL2** (no compute) | rejected: it moves the cheap half (skinning) and keeps the expensive half (animation, per-mesh draws) |
| D. Animation in a Web Worker | clip evaluation off the main thread; the matrices posted back | as A | as A | yes | rejected for now: the per-mesh evaluation and draws stay on the main thread, and it adds a frame of latency; B removes both |
| E. GPU keyframe evaluation (curves in a texture, evaluated per vertex) | as B | heavier than B (per-vertex curve evaluation) | yes | yes | rejected: B gives the same CPU result with a simpler shader; revisit only if VAT memory grows past §2.5's budget |
| F. Impostors (sprite sheets) for far characters | ≈ B | cheapest | no | yes | not now: at 20–60 m a character is 40–120 px tall, impostors read flat; TOWN_LIFE made the same call for the townsfolk |

### 3.3 Vendor notes

- **AMD (the dev PC), NVIDIA**: B is texture-fetch bound in the vertex shader; at ≤ 60 T2 characters × ≤ 2,500
  vertices (the bench player draws 1,237) it is ≤ 150 k skinned vertices a frame [projected], well under what either
  vendor's mid-range does in 0.2 ms. Measured on the dev PC: the GPU time of the plaza is 2.5–2.8 ms for the whole
  frame in every Medium plaza variant, the crowd tier included (§1); on High 5.0–5.7 ms in every variant [confirmed:
  `cp_webgpu_high_*.json`]. No NVIDIA machine was measured [unknown]; nothing in B is vendor-specific.
- **The CPU is the vendor question.** The frame is CPU-bound (§1.1), so a slower CPU scales the whole projection, and
  the 12 ms target was set on the dev PC (Ryzen 5 9600X). An Apple M1's single thread is ≈ 0.7× of it [likely: public
  single-core scores], so the Medium plaza would read ≈ 9.5 ÷ 0.7 ≈ 13.5 ms and the fight ≈ 15 ms on an M1
  [projected]: under the 16.7 ms line, over the 12 / 13 ms targets. The targets of §10 are dev-PC targets; G1 (16.7)
  is the one that must hold everywhere, and N1's Mac run is what confirms it.
- **Apple (M1+, Safari and Chrome)**: WebGPU on Metal and WebGL2 on ANGLE/Metal both take RGBA16F textures and vertex
  texture fetch. The risk is the tile-based GPU's vertex cost with large instance counts; the T2 shader's
  interpolation and crossfade are per-preset switches (`crowdSkin: 'full' | 'nearest'`), and Medium on an integrated
  GPU uses `'nearest'` for T2 beyond 25 m [decision]. A friend's Mac run is in §18.
- **Half-float precision**: TOWN_LIFE's tolerance (1 mm at float32, 3 mm at half float) holds for player skeletons too
  (the bone translations live in the same 1–2 m range) [likely: the townsfolk use the same Chinese skeletons]; the
  converter test checks it per VAT.

---

## 4. Part merging

### 4.1 T0/T1: keep the rescue's merge, freeze the materials

- Today [confirmed: census]: a Chinese man in the starter outfit draws **8 parts** (face, hair, upper and lower arm
  on `chinaman_body`, three garment pieces, the sword); the rescue's merge (`mergeSkinnedParts`) makes it **6**: the
  face and arms become one mesh. All bots share the same materials and geometry objects (the glb container's), so
  instancing needs no new materials [confirmed: material and geometry ids equal across actors].
- **One draw per character** for T1 would need the garments' textures in one texture array (the parts have different
  materials: `clothes_01_ba/la/fa`, `sword1_2_3`, the hair). It saves ≈ 4 draws per T1 character, i.e. ≈ 16–20 draws
  on Medium, ≈ 0.5–1 ms [projected from §1.3's per-draw cost]. **Not this wave** [decision: T1 is ≤ 5 characters
  now; the texture-array work belongs with the final pass's texture budget; scope-cut item 1 already].
- **Frozen materials for T1** [decision]: Babylon PBR re-runs `_prepareDefines` for every submesh every frame unless
  the material is frozen (the rescue's profile). Character materials change only on a dye, a fade, a highlight or a
  preset switch: freeze them and unfreeze for one frame on those events. Measured as the knob `freeze` in §1.3:
  the main pass −0.8 ms on both WebGPU pages; the frame −1.1 / +0.2 ms at p50 (inside the noise at p95). Small but real
  and nearly free: kept for T1 and for the crowd material (CP-S).

### 4.2 T2: one draw per outfit, shared by everyone wearing it [decision]

- Per-part instancing (the prototype's first form) draws every T2 character that wears a part in **one draw** per
  part: twenty bots in the same outfit are **6 draws** for all twenty instead of 6 each [confirmed: §11].
- **But the worst case decides**: twenty friends rarely wear the same thing. With every character in its own outfit,
  per-part batches are 6 draws per character again, and the gain mostly goes: per-part batches with twenty different
  outfits read 19.6 ms on the plaza (today 21.9, the shared outfit 13.8) and 19.2 in the fight (today 27.6, shared 15.0)
  [confirmed: §11.2 `unique`].
- **The outfit batch** (§2.3) fixes it: one merged mesh per outfit, one material reading the crowd texture array,
  instanced over everyone in that outfit. The prototype's cost proxy for it (`unique1`: every character its own batch
  of one draw) measures 12.7 ms on the plaza on WebGPU (10.1 on WebGL2), the same as the best case.
- Monsters and NPCs: one batch per model (their parts already share a material), instanced.

---

## 5. Animation LOD and update throttling (beyond the wave-11 rescue)

### 5.1 What the rescue does today [confirmed: `crowd-budget.ts`, `models.ts` ANIM_LOD]

ANIM_LOD by screen size (full at ≥ 0.12, then 30/20/10 Hz); in a crowd (≥ 10 others within 50 m) others beyond 15 m at
20/15/10 Hz by distance; off screen 'slow' or 'freeze'; a blend forces every frame. Within 15 m everything is full rate.

### 5.2 This spec

- **T2 has no animation cost to throttle**: the GPU reads the row; the CPU writes a clip row only on a clip change and
  the matrix every frame. "Animation LOD" for T2 becomes **matrix-write LOD**: a T2 character beyond 40 m that did not
  move skips its matrix write (its stable slot keeps last frame's value, §2.3; the upload uses
  `thinInstancePartialBufferUpdate` over the dirty range) [decision; cheap, but it removes the last per-frame loop over
  far characters].
- **T1 keeps the rescue's rules**; within 15 m full rate (they are the people you look at).
- **The per-actor loop itself** [confirmed: the VAT profile, §1.4]: with the clips gone, what is left per actor per
  frame is the library's LOD tick (`lodTick`, and `blending()`, which walks all 75 groups of a player every frame) and
  `EntityView.update` (movement, height, facing). Fixes [decision]:
  - `blending()` walks only the started groups (a list kept by `play`), not all 75;
  - `EntityView.update` of a T2 character beyond 40 m and not moving runs at 10 Hz (positions are interpolated on the
    server's move messages; a standing far character has nothing to update);
  - the label anchor (`labelAnchor`, `toScreen`) of a T2 character is computed from the root and the model height, not
    from the head bone (T2 has no live bone).
- **Off-screen T2 characters**: no clip-row change and no label work; inside the caster range of their cascades they
  keep their slot and their matrix write (they cast, §6); outside it they leave the buffer (§2.3).

---

## 6. Shadow-caster budgets

### 6.1 Today [confirmed: `crowd-budget.ts`, rescue bench]

Medium: the 6 nearest other characters cast into both cascades, the rest get a soft blob (one instanced draw for all).
High/Ultra: the 10 nearest cast into every cascade, the rest into cascade 0. Every caster is a skinned part: a player
is 13 shadow draws when it casts (the rescue's count).

### 6.2 With the tiers [decision]

| Preset | T0 / T1 | T2 | Blobs |
|---|---|---|---|
| Low | as today (no shadows) | – | – |
| Medium | all cast, every cascade (≤ 5 characters) | **cascade 0 only**: one shadow draw per crowd batch | **T2 characters beyond cascade 0** (≈ 11.5 m from the camera) within 50 m keep the rescue's blob (one instanced draw for all, as today and as measured) |
| High | all cast, every cascade (≤ 7) | cascade 0 + cascade 1 | none |
| Ultra | all cast (≤ 13) | every cascade | none |

- **Why T2 can cast again:** a crowd batch is one shadow draw per cascade for all the characters wearing that outfit.
  Measured: the crowd tier's cascade-0 casters cost ≈ 0.25 ms of shadow pass for 59 characters (0.95 vs 0.70 ms; p95
  13.8 vs 12.9, within the spread) [confirmed: §11.2 `vatnocast`].
- **Why the blobs stay on Medium** [decision; fact-check §0.2 item 1]: Medium's cascade 0 reaches only ≈ 11.5 m from the
  camera [projected: `csmSettings` gives 2 cascades, maxZ 60 m, λ 0.7; the camera's minZ is 0.2 (`screens/world.ts`);
  Babylon's practical split puts the first break at 0.7 × 3.5 + 0.3 × 30.1 ≈ 11.5 m], and the camera orbits up to 40 m
  away, so most T2 characters stand beyond it. Without blobs they would have no ground contact at all (today they have
  a blob within 50 m). Every timed `vat` run kept the blobs (`vatproto.js` leaves the game's blob logic running;
  `vatnocast` is "the rescue's blobs only"), so the measured numbers already include them; CP-R only hides a T2
  character's blob while it stands inside cascade 0 (the split distance read from the generator each plan).
- **High** casts T2 into cascades 0–1 (≈ 33 m from the camera [projected, λ 0.8, maxZ 150]) with no blobs: today High's non-casters
  cast into cascade 0 only, so this is a gain.
- The cascade limit for a caster **source** does not exist today (`WorldShadows.characterCascades` keys character
  roots only; a source's mesh gets the cascade culling by its bounding sphere) [confirmed: `shadows.ts` 1139–1210,
  1360–1420]. The prototype wrote its batches into the shadow's `limited` map every frame; the build adds
  `ShadowCasterSource.cascades?: number` (one optional field, read where `limited` is filled) [decision].
- **The bounding sphere** of a crowd batch is rebuilt from its drawn instances every frame (as the townsfolk do), so the
  cascade culling still skips a batch whose characters are all outside a cascade.

---

## 7. Instancing identical monsters

- **Monsters are T2 by default** (§2.1): a nest of twenty Mangnyang is **one draw** for all twenty (its body and
  weapon are one merged mesh), and one shadow draw per cascade [confirmed: the prototype converts the 20-monster crowd
  to one batch of 20 instances, §11].
- **Per-instance variation** that monsters have today (the scale of champions and giants, a tint for elites in
  CLIMB's bands, the nemesis aura in wave 15): the scale is in the instance matrix; the tint is a row of the dye table
  the instance's dye-row index points at (the same path dyes use, §2.3); auras stay effects on the actor's root (which
  stays enabled in T2, §2.3).
- **Death, fade and corpse**: DIE1/DOWN_DIE play from the clip clock; the fade-out is the instance alpha
  (`SroTownFadePlugin`'s dither, already in the crowd material) [decision].
- **Mobs that ride or carry** (Tiger Girl and her Blue Tiger, the cart donkeys): T1 composites, as today.
- **The fields** gain the most: the meadow and fields-night scenes had 69–79 tracked mobs (wave11/budgets.md), all of
  which become a handful of batches.

---

## 8. Per-frame allocations and GC

### 8.1 Measured [confirmed: prof.js heap samples over each 400-frame run, `allocMBps`, `gcDrops`]

See §1.5: the plaza allocates 0.74 MB a frame today and 0.45 MB with the crowd tier (the floor without the other
characters is 0.38); the fight 1.29 → 0.92 MB. Heap drops of ≥ 0.5 MB per 400 frames: 11 → 7 (plaza), 19 → 15 (fight).
The rescue found the fight's p95 driven by GC spikes; with the crowd tier the frames over 16.7 ms fall from 305–388 to
0–30 of 400 in the fight (§11.2), so the spikes no longer cross the line.

### 8.2 What allocates, and the cuts [decision]

- **Already done** (waves 9–11): the pooled clip interpolation (`installPooledInterpolation`, ≈ 145 KB a frame at the
  plaza), the fx renderer's per-particle arrays (the rescue), the name tags' forced style recalculation (the rescue).
- **T2 removes the per-character allocators** with the characters' Babylon objects: animatables and their runtime
  animations, the per-mesh draw path (Babylon allocates in its per-mesh render path: the rescue measured ≈ 0.75 MB a
  frame in the 20-player fight for the whole draw path).
- **The rest is the fight's effects** (the skill and hit effects, ≈ 0.7 MB a frame in the rescue's profile before its
  fix): the per-frame `SkillFx.update` and the hit-effect spawns. The cuts: pool the hit-effect instances (a spawned
  `hit_2_redblood` is 9 emitters built per hit today) and the damage-number DOM nodes [decision; measured in the fight
  as the alloc rate difference in §8.1].
- **The GC budget** [decision]: the 20-player fight ≤ 0.3 MB allocated per frame on Medium, the plaza ≤ 0.2 MB, measured
  by the LAB's `allocMBps ÷ fps`; a run with a frame over 33 ms that coincides with a heap drop is reported.

---

## 9. Name tags and HUD

### 9.1 Today [confirmed: code, profiles]

Every entity has a DOM label (`.entity-labels`, `EntityView.updateLabel`), placed every frame by projecting its head
(`toScreen`), then de-cluttered (`layoutPlates`: nudges and fades). The rescue removed the forced style recalculation
(a ResizeObserver for the canvas size) and writes a label's style only when it moved. The 20-player plaza holds ≈ 60
labels (20 bots, 20 monsters, the NPCs).

### 9.2 Measured

With the label layer hidden (`display: none`) the plaza reads 20.6 vs 21.9 ms p95 and −0.2 / −0.9 ms at p50 on two pages
[confirmed: §1.3 `tagsoff`]: the DOM side of 60 labels is ≤ 1 ms. The JS side (`updateLabel`, `layoutPlates`,
`labelAnchor`: ≈ 1–2 % of the samples in the profiles) stays in "logic" and is what §9.3 trims.

### 9.3 The design [decision]

- **Labels stay DOM** (the retail fonts, outlines, badges, guild tags and click-through are CSS; a canvas or GPU text
  layer would redo all of it for a small gain).
- **Far labels update at 15 Hz**: a label whose entity is beyond 25 m (where mobs already show their name only) is
  projected and placed every 4th frame at 60 fps; the label is a few pixels tall and moves less than a pixel a frame.
- **T2 anchors from the root** (§5.2): no bone read.
- **No string per label per frame**: `updateLabel` builds the transform string for every visible label every frame
  to compare it with the last one [confirmed: `entities.ts` 672–690]; compare the rounded numbers first and build the
  string only on a change (the projection itself already uses pooled temporaries, `three/project.ts`).
- **The HUD** (the bars, the chat, the minimap) is outside the character cost and was not measured here; the final
  performance pass keeps it (BACKLOG item 9).

---

## 10. Budgets and targets

### 10.1 Scene targets (LAB-CP gate rows; WebGPU and WebGL2, p95, median of 3, quiet machine) [decision]

| Scene (LAB-CP) | Today [confirmed today; projected at the gate's state] | Target WebGPU Medium | Target WebGL2 Medium | Target WebGPU High (G2, reported) |
|---|---|---|---|---|
| **20-player plaza** (20 monsters + 20 players + the town) | 21.9; ≈ 13.6 (the gate 12.7) | **≤ 12.0** (the task) | ≤ 9.0 | ≤ 14.0 |
| **Tiger Girl, 20 players**, first and second fight on a page | 27.6 / 24.5; ≈ 17.1 / 15.2 | **≤ 13.0** | ≤ 10.0 | ≤ 16.0 (D23 step 1, T1 at 4 in a crowd fight: ≈ (23.1 + 4 × 0.6) × 0.62 ≈ 15.8, **≈ 16.2 with cloth's 5 sims: over**; step 2, T1 at 2: ≈ (23.1 + 2 × 0.6) × 0.62 + 0.2 ≈ 15.3) |
| The same plaza, every player in a different outfit (LAB-CP's dresser: the bots wear random level-1–20 sets) | –; the proxy 12.7 with one draw per outfit | ≤ 12.5 | ≤ 9.5 | – |
| The empty plaza at noon | 9.3; 5.8 | unchanged (± 0.3) | unchanged | unchanged |
| Low (Classic) every scene | – | unchanged (the Low guard) | – | – |

Projected for the build at the gate's machine state [projected: §11.2's `vat4` row × 0.62, plus the build's extra
GPU work for interpolation and crossfade, which the GPU's 2.6 ms leaves room for]: the plaza ≈ 9.5–10.5 ms, the fights
≈ 10.4–11.5 ms on WebGPU Medium; WebGL2 ≈ 6.5–7.5 ms. Every **Medium** target holds with ≥ 1.5 ms to spare on the dev
PC (a CPU at ≈ 0.7× its single thread, an M1, eats that margin: §3.3). **High** is tighter: the plaza ≈ 12.9 with
`vat6`, ≈ 13.4 with cloth's 7 sims (under ≤ 14.0); the fight needs D23's second step with cloth (the cell above). The
High numbers reuse Medium's × 0.62, which was not calibrated on High [projected]. **WebGL2 High** was not measured
[unknown]: wave 12 read its 20-player plaza at 14.2 (1 run, LAB-12); with WebGL2 Medium's measured ratio (`vat4` ÷
`base` = 0.77) that is ≈ 11 ms [projected]; CP-L adds the row (target ≤ 12.0) with the default that High uses the same
T1 and D23 rules on both backends.


### 10.2 Unit budgets (what each piece may cost; CP-L reports them) [decision]

| Piece | Budget (CPU, dev PC, Medium) | Measured basis |
|---|---|---|
| A T2 character (any kind) | ≤ 0.03 ms a frame | ≈ 0.04 ms in the prototype on the busy machine, ≈ 0.025 at the gate's state (§1.3) |
| A T1 character | ≤ 0.35 ms a frame (before cloth) | ≈ 0.53 on the busy machine, ≈ 0.33 at the gate's state (§1.3) |
| A crowd batch (one outfit or model, all its instances) | ≤ 0.02 ms main pass + ≤ 0.01 ms per cascade | §11.2 draws ÷ time |
| The T2 GPU cost (60 characters, `SroCrowdSkin` full) | ≤ 0.5 ms GPU on the dev PC; ≤ 1.5 ms on an M1 [projected; N1 measures] | 2.5–2.8 ms for the whole frame in every plaza variant, the crowd tier included (§1) |
| The crowd VATs in memory | ≤ 40 MB VRAM at once (8 player VATs + the monsters' and NPCs'); ≤ 6 MB and ≤ 4,096 rows each | §2.5 (sized from the animation packs) |
| The crowd arrays | ≤ 40 MB VRAM with both genders loaded (albedo 256² ≈ 16.5 + atlas 512² ≈ 6.3 + dye masks ≈ 12) | §2.3 [projected] |
| Allocation | ≤ 0.2 MB a frame at the plaza, ≤ 0.3 MB in the fight | §8.1 |
| Promotions | ≤ 2 a frame, each ≤ 2 ms (no frame over 33 ms from a promotion) | CP-A's test + the LAB's walk-through |

### 10.3 Headroom for cloth and hair [projected]

- **Medium, the 20-player plaza**: projected ≈ 9.5–10.5 ms against the 12 ms target and the 16.7 ms line: **≈ 1.5–2.5
  ms under the target, ≈ 6 ms under the line**. CLOTH's Medium cost is +0.25–0.35 ms (5 simulated actors, CLOTH §7):
  it fits inside the target. Hair later (a tassel chain per T0/T1 head, ≈ 10 µs each [projected from CLOTH's 12 µs per
  robe tick]) adds < 0.1 ms.
- **The fights**: ≈ 10.4–11.5 ms projected, so cloth's +0.35 ms keeps them under 13 ms.
- **High**: the T1 count is what costs (≈ 0.5 ms a skinned character at p50 with its cascades, §11.2's `vat9`): High's
  T1 is 6 (not CLOTH's 10) so the 20-player plaza stays ≈ 13.4 ms at the gate's state with cloth's 7 sims, under
  ≤ 14.0 [decision D2; projected from `vat6` 12.9 + ≈ 0.45 ms cloth]. **The High 20-player fight has no headroom**:
  ≈ 15.8 with T1 4, ≈ 16.2 with cloth, so D23's second step (T1 2 in a crowd fight) applies when CP-L's quiet run with
  cloth reads over 16.0 [projected].
- **Not covered by this headroom**: the townsfolk (cut 20 already hides them with ≥ 15 players), WARDROBE's new
  civilian variants (draws per variant, TL-V's budget), and effects in the fights (the rescue's caps stay).

---

## 11. The prototype: the crowd tier in the real game page

### 11.1 What was built [confirmed: `work/tmp/charperf/tools/vatproto.js`, run in the production bundle of HEAD]

The biggest single win, built **inside the real game page** (not a mock scene), so every other cost of the frame is
the game's own: the town, the sky, the post stack, the labels, the effects, the bots' and monsters' game logic.

1. **Bake in the page.** For each character kind (model code + worn parts) it takes the first actor of that kind and
   evaluates every one of its animation groups at 30 rows/s straight from the clips (`Animation.evaluate`, no group
   start, so no events fire), poses the skeleton (`Skeleton.prepare(true)`), and writes the 43 skin matrices, one row
   per frame, folded with the part's transform to the actor root, plus **one slot per rigid part** (the sword: its world
   matrix relative to the root). Float32, `RawTexture` + Babylon's `BakedVertexAnimationManager` (the townsfolk's
   classes, borrowed from the page). The bench character's 75 clips are 3,833 rows, 10.5 MB at float32, baked in
   ≈ 1.5 s once per kind (the build bakes offline at half float, §2.5).
2. **Batches.** Per drawn part, a new mesh over **the part's own GPU vertex buffers** (no copy: the slim glbs'
   quantized formats) with thin instances (`matrix` + `bakedVertexAnimationSettingsInstanced`), the part's material,
   an unlinked skeleton (Babylon needs one for `NUM_BONE_INFLUENCERS`, TOWN_LIFE's fact-check). The rigid sword gets a
   copy of its 84 vertices with every vertex on its bone slot.
3. **Convert.** Every other character (not the bench character, not Tiger Girl and her tiger, not static models) is
   switched to its kind's batches: its root disabled (no mesh, no skeleton, no shadow of its own), its pose evaluation
   slowed to 5 Hz (only so that Babylon's groups keep firing the game's end events; the build replaces them with the
   clip clock, §2.4).
4. **Per frame** (before the active-mesh evaluation): for each converted character, its root's world matrix into each
   part's instance buffer, and the clip row it shows (the dominant playing group, its frame extrapolated from the last
   evaluation; speed 0, so the CPU picks the row). The batch's bounds follow the instances. The batches cast through a
   `ShadowCasterSource`, limited to cascade 0 (the prototype writes the shadow's `limited` map).
5. **Variants:** `keep: N` (the N nearest other players stay skinned: T1), `unique` (every character its own per-part
   batches: twenty different outfits), `unique1` (every character its own batch of one part only: the cost proxy of
   one draw per outfit; it draws one part, so its look is not the point), `cast: 0` (no crowd shadows).

What it leaves out (and the build adds, §2.3): the crossfade (a clip change snaps), row interpolation, the arm layer,
the outfit batch and its texture array (it batches per part; `unique1` stands in for the cost), the body volume, the
socket CPU copy (others' glows on a hand disappear while converted), dyes, riders (every rider pair was skipped).
What it does that the build must not: it disables the actor's **root** (so a converted NPC's pick box and any aura on
the root vanish); the build disables the drawn parts only (§2.3). What it kept that the design first dropped: the
rescue's blobs (every timed `vat` run drew them, §6.2). `unique1` draws one part per character, so it also understates
the vertex and fragment work of a full outfit; the frame is CPU-bound, so that is GPU time the dev PC does not notice.

### 11.2 The numbers

p95 ms (spread), median of 3 interleaved runs, 1920 × 1080; p50 in brackets [confirmed:
`shots/cp_webgpu_medium_H.json`, `cp_webgl2_medium_L.json`, `cp_webgpu_high_Hi.json`]. Today's machine reads ≈ 1.6×
the mini-wave gate (§1); the last column projects to the gate's state (× 0.62 WebGPU: 5.8 ÷ 9.3, the empty plaza; × 0.53
WebGL2: 8.4 ÷ 15.9, the 20-player plaza) [projected].

**WebGPU Medium**

| Scene | today (`base`) | **crowd tier, all others** (`vat`) | **+ 4 nearest players skinned** (`vat4`, the Medium T1) | 20 different outfits, per-part batches (`unique`) | 20 different outfits, one draw each (`unique1`, the outfit-batch proxy) | `vat4` at the gate's state |
|---|---|---|---|---|---|---|
| 20-player plaza | 21.9 (19.6–22.0) [18.5] | **13.8** (12.3–14.0) [10.8] | **15.4** (14.9–15.4) [12.9] | 19.6 (19.3–20.5) [16.7] | **12.7** (12.6–13.2) [10.5] | **≈ 9.5** |
| Tiger Girl, 20 players, 5906 | 27.6 (22.2–28.1) [19.3] | **15.0** (13.5–17.9) [11.1] | **16.8** (14.4–17.4) [12.1] | 19.2 (18.1–19.9) [15.3] | – | **≈ 10.4** |
| Tiger Girl, 20 players, 5659 (second fight) | 24.5 (23.9–26.2) [19.3] | **13.3** (13.1–15.3) [10.0] | **16.7** (14.0–19.3) [11.8] | – | – | **≈ 10.4** |
| Draws (plaza / 5906) | 355 / 303 | 191 / 150 | 262 / 183 | 468 / 268 | 220 / – | |
| Frames over 16.7 ms of 400 (plaza) | 247–379 | 0–4 | 1–7 | 146–208 | 0–1 | |

**WebGL2 Medium**

| Scene | `base` | `vat` | `vat4` | `unique` | `unique1` | `vat4` at the gate's state |
|---|---|---|---|---|---|---|
| 20-player plaza | 15.9 (15.8–16.2) [13.0] | **10.5** (10.4–10.9) [8.3] | **12.2** (11.1–13.3) [9.9] | 15.3 (14.7–15.4) [12.5] | **10.1** (9.5–10.3) [7.9] | **≈ 6.5** |
| Tiger Girl, 20 players, 5906 | 17.4 (16.6–18.2) [13.5] | **11.8** (11.6–12.6) [8.6] | **12.9** (12.3–15.1) [9.7] | – | – | **≈ 6.8** |

**WebGPU High** (G2 reports; T2 casting into cascades 0–1)

| Scene | `base` | `vat` | `vat6` (the High T1) | `vat9` (CLOTH's High count) | `unique1` | `vat6` at the gate's state |
|---|---|---|---|---|---|---|
| 20-player plaza | 26.4 (24.8–26.6) / 27.9 (27.7–32.5) [22.3] | **16.6** (16.1–18.9) / 16.9 (16.8–17.1) [13.5] | **20.8** (20.1–21.5) [17.3] | 23.8 (22.9–26.7) [18.3] | 15.7 (15.3–16.6) [13.2] | **≈ 12.9** (G2 ≤ 14 for the crowd) |
| Tiger Girl, 20 players, 5906 | 33.8 (32.2–36.2) [27.4] | **23.1** (23.1–25.8) [18.6] | – | 28.5 (28.1–32.5) [22.4] | – | ≈ 16.6 (projected: `vat` + 6 × 0.6 ms, × 0.62): at the line, hence D23 (T1 drops to 4 in a crowd fight) |

(two pages: `Hi` and `Hi6`; the plaza's `base` and `vat` were measured on both)

**What the variants say:**

- **The crowd tier is the win**: −37 % at p95 and −42 % at p50 on the plaza, −46 % in the first fight, −46 % in the
  second (WebGPU); −34 % / −32 % on WebGL2. The frames over 16.7 ms go from most of them to almost none.
- **Keeping the Medium T1 (4 skinned players) costs 1.6–3.4 ms** at p95 (≈ 0.5 ms each at p50): the near set must stay
  small (D2).
- **Per-part batches fail the worst case**: with every character in a different outfit (`unique`), the per-part
  batches draw 6 meshes per player again and keep only a third of the gain (19.6 vs 21.9). **One draw per outfit**
  (`unique1`) is as fast as the best case (12.7 vs 13.8): hence the outfit batch and the crowd texture array of §2.3.
- **The crowd tier's own shadows** (cascade 0) cost ≈ 0.25 ms of shadow pass (`vatnocast`: 0.70 vs 0.95 ms; p95 12.9 vs
  13.8, within the spread) [confirmed: §6.2's choice to cast].
- **The GPU does not notice**: the frame's GPU time is 2.5–2.8 ms in every plaza variant (timestamp sum, p50).


### 11.3 How it looks

`work/tmp/charperf/charperf-sheet.png`: the plaza and the fight, today and the crowd tier, and the bar chart. Each look
pair (`shots/pair_plaza2_{today,crowd}.jpg`, `shots/pair_tiger_{today,crowd}.jpg`) is **two consecutive frames**, the
tier switched in between: positions, garments, swords, the monsters' attack poses and the shadows match. Where they
differ, it is the prototype's clip pick: it shows the first playing clip when two play at the same weight (a revived bot
still has its DIE clip running under the new one), and it has no crossfade. The build's clip clock knows the one clip
that shows (§2.4). The timed runs wrote one clip row per character per frame exactly as the look pairs' version does;
the fix after the timings (clip rows keyed by clip name instead of the exemplar's group objects) changed which row is
written, not how many.

### 11.4 What the prototype proves, and what it does not

- **Proves** [confirmed]: the crowd path draws the game's characters (players with their garments and swords,
  monsters with weapons, NPCs) through the game's own PBR materials, shadows and post stack on WebGPU and WebGL2 with
  0 WebGPU validation errors; the frame cost of the converted characters drops to ≈ 0.04 ms each; the draws drop with
  instancing; with twenty different outfits only one draw per outfit keeps the gain (`unique` vs `unique1`).
- **Does not prove** [unknown until CP-R]: the cost of `SroCrowdSkin`'s extra fetches (interpolation, crossfade) on
  Apple and integrated GPUs (§18 N1); the clip clock's fidelity on every clip (CP-A's replay test); the promotion
  hitch (the prototype's conversions are all at once, outside timed frames).

---

## 12. Seams with the rest of wave 14 and later waves

| With | The seam | Owner |
|---|---|---|
| **docs/CLOTH.md** (cloth on garments) | Cloth simulates **T0 and T1 only**; CLOTH §6.5's counts become T0 + T1: **Medium 5 (as CLOTH), High 7 (CLOTH: 10), Ultra 13 (CLOTH: 20)**, ranked by the same plan (one ranking, in `crowd-budget.ts`): a simulated garment needs a live skeleton, and a skinned character costs ≈ 0.5 ms on High (§11.2 `vat9`). CLOTH's **2 "warm" actors** (kinematic cloth glb, a live skeleton) occupy T1 slots too, so the cap is the number of live skeletons: on Medium the 4 T1 slots hold the simulated and the warm actors together (CLOTH adopts this, or Medium's T1 becomes 6 at ≈ +0.4 ms, still under 12 ms [projected]). T2 wears the garment's **plain glb** (CLOTH's own rule for every non-simulated wearer, §2.5). CLOTH's gate (`cloth on − off ≤ 0.35 ms` CPU p95 on the 20-player plaza) is measured **on top of** this foundation | the tier ranking: CP-A; the plain glb's crowd mesh: CP-V like any item |
| **docs/WARDROBE.md** (townsfolk civilian clothes) | The townsfolk stay on their own VAT crowd (`town/crowd.ts`); the new civilian variants are TL-V variants. The crowd renderer of §2.3 generalises the townsfolk's: the shared pieces (the rebased time base, `vatOffsetFor`, the fade plugin, the warm-up hook) move to one module both use [decision: `packages/world-render/src/crowd/`] | CP-0 moves, CP-R extends |
| **docs/WARDROBE.md** (new armour sets, W15-A..E) | New sets are ordinary equipment glbs skinned to the shared skeleton: a new set costs no VAT memory (§2.5), only its crowd meshes, its 1024² atlas as one layer of the **512² atlas array** and its dye mask as a mask layer (§2.3). In T2 a set is part of **one outfit batch** per distinct outfit, not "6 batches shared by every wearer" (WARDROBE §4.6 still reads the earlier per-part form) | WARDROBE's lanes add items; CP-V's verb picks them up |
| **docs/WARDROBE.md** (dyes) | T0/T1: `SroDyePlugin` per part (WARDROBE §7.3). **T2: WARDROBE's D34**: the instance carries a **dye-row index**; the dye table holds 8 slots × 3 channels per dyed character; the **equipment slot is per vertex** in the outfit mesh (not a batch uniform: one batch holds all of a character's pieces); the mask comes from the mask array at the vertex's layer. A dyed crowd costs no extra draw | the plugin: WARDROBE's WR-R; the instance slot, the per-vertex slot and the arrays: CP-R / CP-V |
| **Hair** (later) | As cloth: T0/T1 only; T2 hair hangs in its retail pose | – |
| **The Climb** (wave 15: Tomb bosses, nemeses, the Qilin) | Bosses and uniques are T1 always (§2.1); a nemesis's tint is a dye-table row (§2.3), its title a label badge | wave 15 |
| **Arsenal** (weapons, later) | A weapon is a crowd part on a socket slot (§2.3); weapon glows and trails read the socket bones' CPU copy | later |
| **The final performance pass** | Keeps everything not about characters: static draws, the HUD, textures, per-machine defaults, and BACKLOG item 9's friends' benchmark | later |

---

## 13. Lanes

Step 0 (seams, one agent) and step 1 (lanes), before cloth, the clothes and the dyes [decision: the wave plan puts
this foundation first; CLOTH's Medium gate depends on it].

### 13.1 Seams first (CP-0, one agent, 0.5 day)

- `apps/game/src/three/models.ts`: a `tier: 'full' | 'crowd'` on `CharacterActor` with `toCrowd()` / `toFull()`
  stubs, the clip-clock interface (`ClipClock`), and lazy animation groups behind `group(name)` (created on first use;
  the full set kept for T0).
- `apps/game/src/world/crowd-budget.ts`: the tier ranking output (`tierOf(actor)`), counts per preset.
- `packages/world-render/src/render/shadows.ts`: `ShadowCasterSource.cascades?` (§6.2).
- `packages/world-render/src/crowd/` (new folder) with the shared VAT pieces moved out of `town/crowd.ts` (no
  behaviour change: the townsfolk tests stay green).
- `packages/convert/src/cli.ts`: the `crowd` verb line.

### 13.2 Lanes (after CP-0; disjoint files)

| Lane | Files (owned) | Seams it needs | Tests | User check | Effort |
|---|---|---|---|---|---|
| **CP-V** the crowd export | `packages/convert/src/crowd/{vat-sets, sockets, crowd-mesh, texture-array}.ts` (new), the `crowd` verb body, `crowd/index.json` + `crowd/vat/*` + `crowd/mesh/*` + `crowd/array/<gender>{,-atlas,-mask}.ktx2` in the export, the optimize-out entries (Brotli) | CP-0; texpipe's KTX2 encoder; WARDROBE's masks and set atlases as they land | per VAT: a row within 1 mm of the skinned pose at float32, 3 mm at half (the TL-V test, reused), ≤ 4,096 rows and ≤ 6 MB; sockets match the attach bone's world matrix (the horse's saddle included); every item and body part (a cloth garment from its **plain** glb) has a crowd mesh in the one layout whose bind pose equals its glb within 1 mm, whose double-sided triangles exist in both windings, and whose layer index, array bit and equipment slot are right; the arrays' layers match the items' albedo (mean colour within 2 %); sizes within §2.5 and §2.3's budgets; deterministic re-run | the arrays' contact sheet | 3.25 d |
| **CP-R** the crowd renderer | `packages/world-render/src/crowd/{batch, outfit, skin-plugin, instances}.ts` (new): `CrowdBatches` (outfit batches built by concatenating crowd meshes, the outfit cache keyed by the worn items, model batches for monsters and NPCs, stable slots, bounds, the caster source with `cascades`, the Medium blob hand-off at the cascade-0 split), `SroCrowdSkin` (WGSL + GLSL: row lerp, two-clip crossfade, the layer mask, the two arrays' read, the dye row, the body-volume correction; one interleaved vertex buffer and one interleaved instance record; a `ShadowDepthWrapper` so the casters run the same vertex code), the warm-up hook | CP-0 | NullEngine: draws = distinct outfits and models; an outfit built from the same items is reused; one instance write per character; no allocation per frame after warm-up; hidden at count 0; the plugin compiles in both languages (the GLSL guard); **≤ 8 vertex buffers on WebGPU and ≤ 16 attributes on WebGL2** for the crowd pipeline; a "player crowd" row in `material-budgets.test.ts` (≤ 16 units, ≤ 16 inter-stage); pixel test in the LAB: a T2 instance at row r equals the skinned pose at the clip time (≤ 1 px at 1080p) on both backends, and its shadow matches the T1 shadow at the same pose | – | 4 d |
| **CP-A** the actor tiers | `apps/game/src/three/{models, crowd-actor}.ts` (`crowd-actor.ts` new: the clip clock, promotion and demotion, the sockets' CPU copy, riders on their mount's socket), `world/crowd-budget.ts` (ranking, the cap, hysteresis), `world/entities.ts` (label anchor, update throttle) | CP-0, CP-R, CP-V | NullEngine: own is T0; target and hover always T1; party next, **within the preset cap** (a party of 8 on Medium: 4 T1 at most, CLOTH's warm actors included); counts per preset; hysteresis; ≤ 2 promotions a frame; a promotion shows the same pose (bone matrices equal the VAT row within 1 mm); T2 disables the drawn parts, **never the root** (an NPC's pick box still picks, a root aura still draws); a T2 rider stays within 1 cm of its saddle; the clip clock fires the same end and move events as Babylon's groups for every clip of the bench set; Low has no tiers (the Low guard files) | the plaza with 20 friends: nobody snaps, nobody slides, nobody floats (shadow or blob under everyone) | 3 d |
| **CP-S** small CPU cuts | `models.ts` `blending()` over started groups; frozen T1 materials with unfreeze on dye, fade and highlight; `entities.ts` label string; far labels at 15 Hz | CP-0 (serialised with CP-A on `models.ts` and `entities.ts`: CP-S lands first) | a unit test per cut; the live-switch and material-budget guards | – | 1 d |
| **CP-L** LAB and gate rows | `work/` scripts only (this spec's bench harness as LAB-CP: the plaza and both fights, before vs tiers, WebGPU and WebGL2 Medium and High; the harness dresses the 20 bots in random level-1–20 sets for the all-outfits row) | all | the §10 table | – | 0.5 d |

**Total ≈ 12.25 agent-days** with CP-0 [projected], plus integration (0.5 d): ≈ 13. (The fact-check added ≈ 0.75 d:
the arrays for atlases and masks, two-sided parts, the interleaved buffers, the shadow wrapper and the cap tests; it
removed the crowd-skin re-weighting.)

### 13.3 User checks

1. **The plaza with friends** (or 20 bots): walk among them; nobody should snap, slide or lose a weapon when they come
   near (T2 → T1) or walk away.
2. **A Tiger Girl fight with the group**: everyone's attacks and hits still read; the frame stays smooth.
3. **A friend on a Mac** opens the one-minute LAB page (§18): the T2 shader on Apple.

---

## 14. Scope-cut order (cut from the top)

1. **One draw per T1 character** (texture arrays, §4.1): already out of this wave.
2. **The upper-body layer in T2** (§2.3): T2 characters running with a weapon show the full-body run clip.
3. **Row interpolation in T2 beyond 25 m** (`'nearest'` there on every preset): small steps on slow clips far away.
4. **Matrix-write LOD** and the 10 Hz far `EntityView.update` (§5.2).
5. **Far labels at 15 Hz** (§9.3).
6. **T2 shadows on Medium** (§6.2): back to the rescue's blobs only for T2 (the `vatnocast` row: −0.25 ms).
6b. **The 512² atlas array** (§2.3): atlas-sourced sets go into the 256² array (a T2 wearer of a new set reads blurrier).
7. **Lazy animation groups** for T2 (§2.2): T2 actors keep their groups (memory and creation cost, not frame time).
8. **NPCs in T2**: NPCs stay skinned (they stand still; the rescue's rate floors already slow them).

**Never cut:** the T2 crowd tier for other players and monsters, **one draw per outfit** (without it twenty different
outfits lose most of the gain), the crossfade, the sockets (weapons in hands), the seamless promotion, the Low guard,
and the §10 gate.

---

## 15. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A T2 character looks wrong where Babylon's animation does something the clip clock does not (a seek on JUMP, a held last frame, the companion mirror, `setSkeletonVolume`'s per-bone body volume) | the clip clock's tests replay every clip of the bench set against Babylon's groups; anything not covered promotes the character to T1; the body volume is in the T2 shader (§2.3) |
| R2 | Pops at the T1 ↔ T2 swap | the same pose by construction (§2.2); hysteresis; the user check |
| R3 | VAT memory and rows grow with clips (skills, emotions, Arsenal's weapons); the spear family is already ≈ 3,975 of the baker's 4,096 rows | lazy per family; 15 rows/s for skills; a family past 4,096 rows splits its skills into a second texture (the plugin's clip B can read either); §10's budget is a test in CP-V |
| R4 | Apple GPUs pay more for vertex texture fetches | the `'nearest'` switch and the integrated-GPU default; a friend's Mac run (§18) |
| R5 | Effects that read bones of T2 characters (others' skill effects on a hand) appear at the wrong place | the socket bones' CPU copy (§2.3); effects on other bones attach to the root |
| R6 | The one crowd-mesh layout (float positions) costs memory over the slim glbs' quantized parts, and the arrays blur close T2 characters | ≈ 45–60 KB per outfit in one layout (≈ 1,200 vertices × ≈ 36 B, plus the second winding of double-sided parts); the retail textures are ≤ 256² for 112 of 127 (§2.3), the set atlases get the 512² array; if the user check (§13.3) still sees blur within 20 m, the body and chest layers go to 512² (+≈ 10 MB) |
| R7 | The bench's bots all wear the same outfit, so instancing is the best case | the `unique` variant measures the worst case (every character its own batches, §11) |
| R8 | The machine was never quiet during this spec | the numbers are interleaved differences, the absolutes are marked [projected] (§1, §16); CP-L re-measures on a quiet machine before the gate |
| R9 | The crowd pipeline outgrows a hard limit: WebGPU's 8 vertex buffers (the townsfolk are at 8), WebGL2's 16 attributes, 16 inter-stage variables (the crowd material is at 15) | interleaved vertex and instance buffers, one flat varying (§2.3); CP-R's limit tests and the material-budgets row fail the build before a browser does |
| R10 | The 12 / 13 ms targets assume the dev PC's CPU; the frame is CPU-bound, so a slower CPU (an M1 ≈ 0.7×) reads ≈ 13.5–15 ms | still under G1's 16.7; N1's Mac run; the `'nearest'` and blob switches; Medium's T1 can drop to 2 on a machine that misses G1 (an Options-level default, not this wave) |
| R11 | Riders in T2 (players on horses) were never prototyped | the saddle socket and CP-A's 1 cm test; fallback: a ridden pair is one T1 slot (inside the cap) |
| R12 | The High 20-player fight is at the line with cloth (≈ 16.2 ms projected) | D23's two steps; CP-L's quiet High row decides which applies |

---

## 16. Bench method

- **Machine:** the dev PC (Ryzen 5 9600X, RX 9060 XT), Chrome in the Claude browser pane, **one tab of my own** (closed
  at the end), viewport emulation 1920 × 1080 at device pixel ratio 1 (every result records its canvas).
- **Bundles:** HEAD `9629429` built twice into `work/tmp/charperf/tools/`: `dist` (production, minified, the 60 Hz
  timer pump) on a private `vite preview` at :5812, and `dist-prof` (unminified, `Document-Policy: js-profiling`) at
  :5814 for the JS self-profiles only. Never timed against each other.
- **Server:** a private server at :7811 (`tools/harness.ts`, the wave-11 gate's harness with Tiger Girl's camps) over a
  **temp copy of `work/server/game.db`** (deleted at the end), with its 20 bot clients (jumping at the plaza, or
  attacking Tiger Girl every second with her HP held). The dev servers (:5180, :7000, :5173) were not touched.
- **Scenes:** LAB-11's: the plaza at noon with 20 Mangnyang + 20 jumping bots + the town (`crowd-bots`), Tiger Girl at
  camp 5906 with 20 attackers (`tiger-20`), then camp 5659 as the second fight on the page (`tigerB-20`). The camera,
  the hour and the weather as LAB-11 (`bench11.js`); `/heal` before every run.
- **Runs:** 400 uncapped frames after streaming went idle; p95 of the frame-to-frame time; **3 rounds, the variants
  interleaved within each round on the same page** (so a slow minute hits every variant), median of the 3.
- **Variants** (the knobs of `tools/cpbench.js` and `tools/vatproto.js`): `base` (HEAD as it is), `vat` (every other
  character in the crowd tier), `vat4` / `vat6` / `vat9` (the 4, 6 or 9 nearest other players stay skinned: the Medium
  T1, the High T1, CLOTH's High
  count), `unique` (every character its own per-part batches: the all-different-outfits worst case), `unique1` (every
  character its own one-draw batch: the outfit-batch cost proxy), `vatnocast`
  (crowd tier without its cascade-0 shadows), `hide` (others not drawn, their clips running), `hidepause` (others
  neither drawn nor animated: the floor), `freeze` (others' materials frozen), `tagsoff` (the label layer
  `display: none`).
- **Quiet machine:** the GPU lock (`work/tools/gpu.lock`, owner file `charperf <time>`) held for every timed page and
  released after. Before each page, `tools/quiet.ps1` waited for a 30 s window with mean CPU under 15 % and no 2 s
  sample over 25 %. **This spec never got a quiet window.** From 07:05 to 08:51 the machine read 22–35 % (2 s samples;
  41–88 % while the user played a game until ≈ 07:35). The floor was a stale `work/tmp/climb/climb.ts` process at one
  full core since 2026-10-02 06:04 (8 % of the machine, §18 N2), the Claude app and this workflow's parallel design
  agents (≈ 7 %), and the page itself. The timed pages ran after the game closed: during them the whole machine (the
  page, the private server and its 20 bots included) averaged 34 % (the wave-11 rescue gate: 12–18 %), with 67 of 1,641
  two-second samples over 50 % and 15 over 70 % (`cpu.log`); no other page used the GPU; the GPU lock was held from
  07:57 to 08:51, the last timed page. Two earlier WebGPU pages were discarded (`shots/discarded_*`): the prototype then
  kept updating its idle batches every frame and piled up per-character batches across scenes, which slowed the later
  variants; the fixed prototype re-ran every scene on fresh pages (`H`, `L`, `Hi`, `Hi6`). Because of the floor, this
  spec reports **differences between interleaved variants** as measured and **absolute numbers only as projections**
  (§1). CP-L re-measures the absolute numbers on a quiet machine.
- **Raw data:** `work/tmp/charperf/shots/cp_*.json` (every run with its segments, draws, alloc rate, GC drops,
  canvas), the profiles `prof_*.json`, the CPU log `cpu.log`; the tables come from `tools/cp_table.py`.

---

## 17. Decisions (each with its reason)

| # | Decision | Reason |
|---|---|---|
| D1 | Three tiers: T0 own, T1 near (skinned), T2 crowd (VAT + thin instances) | the prototype's measured win is in T2; T0/T1 keep today's quality where you look |
| D1b | T2 draws one batch per outfit: the worn parts concatenated into one mesh in one vertex layout (double-sided parts in both windings), one alpha-tested material reading a 256² crowd texture array (≈ 190 layers, ≈ 16.5 MB) plus a 512² array for set atlases and a mask array for dyes, instanced over everyone in that outfit | per-part batches keep only a third of the gain when twenty players wear twenty outfits; one draw per outfit keeps all of it (§11.2); the second array keeps the new sets as sharp as the retail items |
| D2 | T1 is capped at Medium 4, High 6, Ultra 12, filled with target and hover (always), then party, then the nearest, all on screen within 20 m; CLOTH's warm actors count inside the cap | a skinned character costs ≈ 0.5 ms (§11.2); a party of 8 must not blow the cap; Medium equals CLOTH's count, High and Ultra trade CLOTH's 10 / 20 for frame time |
| D3 | Every other character is T2 at any distance (players, NPCs, monsters) | the 20-player plaza puts most players within 15 m of the camera; a far-only tier misses them |
| D4 | Monsters are T2 unless targeted; bosses, uniques and ridden composites are T1 always | identical monsters instance; bosses carry bone effects and are few |
| D5 | Our own VAT plugin (`SroCrowdSkin`): row interpolation, a two-clip crossfade, the arm layer, the dye row (WARDROBE D34, the equipment slot per vertex), the body-volume correction; interleaved buffers, one flat varying, and a `ShadowDepthWrapper` for the casters | Babylon's VAT settings have none of these; a character next to you must not snap; WebGPU's 8-buffer and the 16-varying limits; the shadow must pose like the body |
| D6 | Rigid parts (weapons, shields) are bone slots in the VAT | they move exactly with the hand, with no per-frame CPU work |
| D7 | One VAT per skeleton and weapon family, half float, 30 rows/s base clips and 15 rows/s skills, ≤ 4,096 rows, loaded lazily | ≈ 3–6 MB each (sized from the animation packs); a solo session holds 2–4, a 20-friend town up to 8 (≈ 35 MB); 15 rows/s keeps the spear family under the baker's row cap |
| D8 | The clip clock replaces Babylon animation groups for T2; groups are created lazily on promotion | removes the per-character animation CPU and the creation cost; the game logic keeps its events |
| D9 | Promotion and demotion with the same pose, ≤ 2 promotions a frame, 3 m / 1 s hysteresis | no pops, no spikes |
| D10 | Cloth and hair only on T0/T1; T2 wears the garment's plain glb (CLOTH's rule for every non-simulated wearer) | the retail look for free; CLOTH's counts are T1's; no re-weighting lane |
| D11 | T2 casts into cascade 0 on Medium and keeps the rescue's blob beyond it (≈ 11.5 m from the camera); cascades 0–1 on High, all on Ultra, no blobs | instanced casters cost one draw per batch and a real shadow looks better than a blob where cascade 0 reaches; beyond it a blob is the only ground contact, and the measured runs kept it |
| D12 | `ShadowCasterSource.cascades?` in `shadows.ts` | the cascade limit exists only for character roots today |
| D13 | Frozen materials for T1, unfrozen for one frame on a dye, fade, highlight or preset change | Babylon PBR re-prepares defines every frame otherwise |
| D14 | T1 keeps its per-material parts (the rescue's merge); the outfit batch and its texture array are T2's only | T1 is ≤ 5 characters (≤ 13 on Ultra); its parts carry cloth chains and dyes per character |
| D15 | Matrix-write LOD (still far T2 skip writes), 10 Hz far `EntityView.update`, `blending()` over started groups only | the per-actor loops are what remains after T2 |
| D16 | Labels stay DOM; far labels at 15 Hz; no transform string unless the label moved | the retail styling is CSS; the cost is the per-frame JS |
| D17 | Low and Classic unchanged | the Low guard: Low loads today's files and code paths |
| D18 | The shared VAT pieces of the townsfolk move to `packages/world-render/src/crowd/` | one VAT runtime for townsfolk, players and monsters |
| D19 | Budgets of §10 become LAB-CP gate rows: the 20-player plaza ≤ 12 ms and the fights ≤ 13 ms p95 on WebGPU Medium | the task's target, with room for cloth (+0.35 ms) and hair |
| D20 | This foundation is step 0/1 of wave 14, before cloth, clothes and dyes | CLOTH's Medium gate depends on it |
| D21 | The slot ids W15-A..D keep their names after the renumbering | they are ids used in CLIMB, TOMB and WAVE_PLAN10 |
| D22 | The prototype stays scratch (`work/tmp/charperf/tools/vatproto.js`); the build writes the real modules | it reads private fields and bakes in the page |
| D23 | In a crowd fight (≥ 10 other characters in combat within 50 m) T1 shrinks to the Medium count (4) on High and Ultra; step 2, to 2, if CP-L's quiet High fight with cloth reads over 16.0 | High's 20-player fight is at the line with 6 (≈ 16.6 ms projected), ≈ 15.8 with 4 but ≈ 16.2 with cloth, ≈ 15.3 with 2 |
| D24 | A T2 actor disables its drawn parts, never its root | the root carries the NPC pick box, auras and attachments (the prototype's root switch would break picking and auras) |
| D25 | T2 slots are stable within a batch; a character leaves the buffer only when outside both the view and its cascades' caster range | off-screen casters still cast, and the matrix-write LOD needs a slot that keeps its value |
| D26 | A rider and its mount change tier together as one slot; in T2 the rider's matrix is the mount's matrix × its saddle socket | players ride horses; one slot keeps the cap honest; no per-rider skeleton |

---

## 18. Needs from the user (each with the default used if there is no answer)

| # | Need | Default |
|---|---|---|
| N1 | One friend on an Apple Silicon Mac (and, if possible, one on NVIDIA) opens the LAB-CP page for a minute once the build lands | the dev PC's numbers only; `'nearest'` T2 skinning on integrated GPUs |
| N2 | A stale process: `work/tmp/climb/climb.ts` (pid 25052, a `node` process) has run at one full core since 2026-10-02 06:04 (The Climb's design run, now wave 15; still running at 09:08 on 10-03 with ≈ 25.9 h of CPU) and keeps the machine from going quiet. May it be stopped? | left running (not this spec's to stop) |

Nothing else blocks the build.

---

## 19. Open questions (each has a default, so nobody waits)

| # | Question | Default |
|---|---|---|
| Q1 | Should T1 be larger on High/Ultra machines (more people swinging cloth up close)? | no: High 6, Ultra 12 (D2); an Advanced Options row "Detailed characters nearby" can raise it later |
| Q2 | Should NPCs ever be T1 when you talk to them? | yes: an NPC you talk to is your target, so T1 |
| Q3 | Should far T2 characters (> 60 m) drop to a cheaper mesh (meshoptimizer LOD) as the townsfolk do on High? | not now: a player is ≈ 1,200 vertices; revisit if a 40-player event shows GPU cost |
| Q4 | Should T2 characters inside cascade 0 also fall back to blobs on integrated GPUs? | yes, if the Mac run (N1) shows the cascade-0 casters cost more than 0.3 ms there |
| Q5 | Should party members always be T1, even past the cap (a party of 8)? | no: target and hover always, party first within the cap (D2); the cap is the frame budget |
| Q6 | Should CLOTH's 2 warm actors sit inside T1's cap or add to it? | inside (Medium 4 live skeletons besides your own); CLOTH's spec adopts it at the wave plan, or Medium's T1 becomes 6 (≈ +0.4 ms, still under 12 ms) |

---

## Appendix A: scratch files (`work/tmp/charperf/`)

| File | What |
|---|---|
| `tools/harness.ts` | the private server :7811 over a temp `game.db` copy, 20 bots, Tiger Girl's camps (from the wave-11 gate) |
| `tools/cp.vite.config.ts` | the game's Vite config for the private previews :5812 (`dist`) and :5814 (`dist-prof`, js-profiling header) |
| `tools/dist`, `tools/dist-prof` | production and unminified bundles of HEAD `9629429` |
| `tools/cpbench.js` | the knobs (`freeze`, `hide`, `pause`, `tags`, `vat`), the interleaved A/B (`C.ab`), the bench plan (`C.plan`), the census, the raw profiler |
| `tools/vatproto.js` | **the prototype**: the crowd tier in the live game page (bake in the page, thin-instance batches, clip rows, cascade-0 casters, the `keep`, `unique` and `unique1` variants) |
| `tools/{look, helpers, prof, bench, bench10, bench11, bench12, rescue, ab11, boot2}.js` | the LAB helpers of waves 9–12 (copied, ports changed) |
| `tools/quiet.ps1`, `tools/cpulog.ps1` | the quiet-window wait and the CPU logger |
| `tools/cp_table.py`, `make_sheet.py` | the tables of §1/§11 and the prototype sheet |
| `shots/cp_*.json` | every timed run |
| `shots/prof_*.json` | JS self-profiles (profiling build) |
| `shots/pair_plaza2_*.jpg`, `shots/pair_tiger_*.jpg` | the look pairs (two consecutive frames) |
| `shots/proto_*.jpg`, `shots/tiger_*.jpg`, `shots/pair_plaza_*.jpg` | earlier look checks (before the clip-pick fix) |
| `shots/discarded_*.json` | the two discarded WebGPU pages and the test run (§16) |
| `sheet.json`, `doc_*.py` | the sheet's input; the scripts that wrote this doc's tables |
| `charperf-sheet.png` | the prototype sheet (before/after, the numbers) |
| `cpu.log` | the whole machine's CPU every 2 s during the timed pages |

