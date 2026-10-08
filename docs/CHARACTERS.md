# The character remaster: our own bases, a creator, 100 players at 60 fps

The user's decisions (2026-10-08), in their words where they gave them:

> Keep the same Silkroad feel, but we can make it our own look.

> This is a very basic game. No need to lose so much performance just because there's 20 players.

- Replace the retail character roster (26 Chinese bodies) with **our own two base models, male and female, and a
  character creator**: body shape, face presets and sliders, skin, eye and hair colour, hairstyles; markings later.
  Chinese style, the same armour classes (garment, protector, armour), much higher quality.
- Keep the **retail Chinese skeletons**, so every retail animation, skill, Berserk, emote and horse ride keeps working.
- Every armour and clothing set is **re-made for the new bases** (Higgsfield concept → the dream-loop judge → Blender,
  rigged to the retail skeleton). Existing players **re-customise once** in the creator and keep everything else.
- **The bar: 60 fps with 100 players on screen, WebGPU and WebGL2, Medium**, on the user's AMD GPU too. This replaces
  CHAR_PERF's 20-player G1.
- Creator additions (2026-10-08, second message): **body sliders on both bases** (breast size small → very large,
  buttocks small → large, hip width narrow → wide, plus waist and thigh) as morph targets that **outfits follow**, and
  **jiggle physics** for the chest (lighter for the buttocks) on a few spring bones, near characters only, off on Low,
  with an Options toggle. Clothing stays the game's normal gear.

This spec replaces and absorbs three unbuilt drafts: **docs/CHAR_PERF.md** (the three-tier crowd and its VAT tier,
kept as §3.5), **docs/WARDROBE.md** (new sets, dyes, costume slots: §8, §8.6) and **docs/CLOTH.md** (the cloth solver:
§9). They stay in the tree as background; where they disagree with this file, this file wins.

**Tags.** **[confirmed]** measured by this track's bench or read in the code or data on 2026-10-06 (each says how);
**[projected]** computed from a measurement; **[unknown]** open, with the default used; **[decision]** a choice made
here, with a one-line reason (§13 lists them). §14 is what the user decides later.

**This job** (P0) built the bench, measured the baseline, and shipped the first crowd speed-ups that need no new art
and change nothing within 15 m of the camera. No Higgsfield, no Blender, no download.

---

## 0. Summary

| Question | Answer |
|---|---|
| Where we are (100 players in the plaza, WebGPU Medium, dev PC under load) | HEAD: **70 ms p50 / 110 ms p95** at the mid view (≈ 14 fps), 1,436 draws, 1,315 active meshes; the same frame without the crowd (the floor) 18.6 / 29.7 ms, so **≈ 0.37 ms per other character** [confirmed: §1.2]. Every frame of every run is over 16.7 ms, before and after |
| What P0 bought | **−35 % p50, −37 % p95 on WebGPU Medium** (mid: 45.5 / 69.2 ms; close −39 % / −48 %, far −43 % / −33 %), draws 1,436 → 729, active meshes 1,315 → 581, ≈ 0.19 ms per other character; WebGL2 Medium −28 to −31 % p50, WebGPU Low −12 to −25 % p50 [confirmed: §1.2]. Nothing within 15 m of the camera changes |
| Where the frame goes after P0 | main draw 19 ms (729 draws: still ≈ 4 per character, the merged body plus weapon, shield, the near characters' parts, the shadow casters), active-mesh evaluation 11 ms (bone and world matrices of the ≈ 74 actors posed per frame), animations 5.6 ms, game logic 6.8 ms. **≈ 190 µs per other character against a budget of ≈ 70 µs**: the remaining gap is per-character draws and CPU animation, which only the new single-mesh models with LODs and the instanced crowd tier remove (§3.4) |
| What closes the rest | **Fewer, cheaper characters per draw**: one mesh + one material per character (the new bases are built that way), three LODs, the instanced VAT crowd tier for everyone beyond ≈ 25 m (CHAR_PERF's T2, kept), animation off the CPU for the crowd. P0's outfit merge is the retail bridge to that layout |
| Frame budget at 100 players (dev PC, Medium, quiet machine) | world + HUD ≤ 7.0 ms, **all other characters ≤ 7.0 ms CPU** (≈ 70 µs each on average), own character ≤ 0.4 ms, headroom ≥ 2.3 ms to 16.7 ms p95 (§2.1) |
| Draws for the characters (main + shadow) | ≤ 140 at 100 players: LOD0 (≤ 8 nearest) ≤ 4 + 2 shadow each, LOD1 (≤ 24) 2 + 1, the crowd ≤ 1 per (outfit, LOD) batch (§2.2) |
| Polygons | LOD0 ≤ 30 k triangles (body 12 k incl. head 4 k, outfit 14 k, hair cards 4 k), LOD1 ≤ 8 k, LOD2 (crowd) ≤ 2 k, impostor 2; ≈ 0.6 M skinned triangles at 100 players (§2.3) |
| Bones | the retail skeleton (43 man / 45 woman) + 4 jiggle bones; no face bones (the face is morphs); cloth chains only on simulated actors (§4.3) |
| Textures | shared, never per character: one albedo / normal / ORM layer per outfit set and per base in a texture array per gender and LOD tier (Medium LOD0 1024², LOD1 512², crowd 256²); skin, eye and hair colours are parameters (§2.4) |
| The creator | 2 bases × 12 face presets × 22 face sliders + 9 body sliders + colours + 12 hairstyles per base at launch; a 64-byte appearance blob, validated on the server; existing characters re-customise once (§5) |
| The build order | **P0** bench + speed foundation (this job) → **P1** pilot: female base, creator basics, 1 outfit, 2 hairstyles, the renderer's LOD tiers, judged ≥ 8 and measured at 100 players → **P2** male base → **P3** every outfit by gear tier → **P4** cloth and jiggle (§12) |

---

## 1. The bench and the baseline [confirmed]

### 1.1 The bench

A reproducible 100-player scene, one command:

```
pnpm charbench                                   # 100 bots, WebGPU Medium + WebGL2 Medium + WebGPU Low, 3 rounds
pnpm charbench --configs webgpu-medium --rounds 1 --views mid --variants before,after
pnpm charbench --serve                           # no Chrome: server + bots + page; open http://localhost:5200/?charbench=1
```

- **Server** (`apps/server/src/cli/charbench-bots.ts`): a private game server on **:7290** over its own temp DATA_DIR
  (deleted at the end), capacity raised to fit, and **N bot players** (default 100) in the Jangan plaza on a
  sunflower spiral 2–20 m round the centre. Seeded (the same crowd every run): genders alternate, every one of the 26
  Chinese bodies in turn, the five weapon families in turn, **gear of every degree in the export (1–3)** in one armour
  class per bot (garment / protector / armour; a bare head one time in three), **+0 to +12 weapons** (a third +0, so
  most weapons glow), **≈ 18 % sealed** (Star 10 %, Moon 5 %, Sun 3 %), shields on half the one-handed ones. The split:
  **30 walk** (a new point in the plaza every 4–7 s), **30 fight** 20 Mangnyang spawned in the plaza (the bench lifts
  the town's safe-area rule in its own process; the monsters never die, the bots are healed), **40 stand** (8 sit,
  8 wave emotes). The bench character is a GM on that server only; its What's new window is marked seen. A control
  endpoint on :7291 (`/tab`, `/status`, `/behave?on=0|1`).
- **Page** (`apps/game/src/debug/charbench.ts`, `?charbench=1`): `window.__sroCharBench` with `prepare()` (noon,
  clear sky, the bench character at the plaza's south edge, waits for every player model and 15 s of settling),
  `view('close' | 'mid' | 'far')` (fixed orbits: 6 m / 16 m / 40 m from the bench character, looking north into the
  crowd), `knobs()` (the CHAR_LOD switches, `hideOthers` for the floor), `measure()` and `run()`. A measurement runs
  **uncapped frames** (a MessageChannel frame pump instead of the display's rAF, so the number is the work, not the
  vsync) and records the frame-to-frame time p50 / p95 / p99, the CPU part of each frame (engine begin → end),
  segments (animations, game logic, active-mesh evaluation, render targets = shadows, main draw, post), draw calls,
  the GPU frame time where the engine can time it, actors posed per frame, and a census (active meshes by kind,
  skinned meshes and vertices, skeletons and bones drawn, labels). The frame watchdog never drops the preset on a
  bench page.
- **Driver** (`apps/server/src/cli/charbench.ts`): builds the game (production, its own Vite cache and output under
  `work/tmp/charbench/`), serves it on **:5200** proxied to the bench server, then **one headless Chrome at a time**
  per configuration (1920 × 1080, DPR 1), runs `run()` (views × variants × rounds, the variants interleaved and their
  order reversed every other round), saves `<config>.json`, `summary.md`, the machine's CPU log and the screenshots,
  and stops everything it started. `--profile mid` adds a JS CPU profile on an unminified build.
- **Variants**: `before` = every P0 rule off (HEAD as it was), `after` = every P0 rule on, `floor` = every other
  character hidden and paused (the frame without the crowd), `only-<rule>` = one rule alone.

**Method notes** [confirmed]: headless Chrome 154 used the real GPU on both backends (WebGPU adapter `amd / rdna-4`;
WebGL2 `ANGLE (AMD, AMD Radeon RX 9060 XT Direct3D11)`), so the GPU numbers are this GPU's. Headless has no
compositor pacing, so read the numbers as **throughput** (what the frame costs), not as what a vsynced tab shows. The
dev PC (Ryzen 5 9600X, RX 9060 XT, 16 GB) was **never quiet**: the other two helpers' processes, the Claude app,
Discord and Dropbox kept it at ≈ 35 % CPU before the bench started, and the page, the server and its 100 bots shared
the same 6 cores; free memory dipped to ≈ 120 MB in one run. So absolute numbers are high; **the before/after
differences are interleaved on one page in the same minutes** and are the result. To measure in a real browser on
any machine: `pnpm charbench --serve`, open the page, then in the console
`await __sroCharBench.prepare({ minPlayers: 95 }); await __sroCharBench.run(); __sroCharBench.download()`.

### 1.2 The baseline (HEAD before P0) and P0, 100 players

Medians of 3 interleaved rounds, 300 uncapped frames each, 1920 × 1080, frame-to-frame time in ms; "per other
character" = (frame − floor) ÷ the 140 other actors (100 players, 20 Mangnyang, ≈ 20 NPCs). Raw runs:
`work/tmp/charbench/p0/<config>.json`; this table: `work/tmp/charbench/p0/tables.md` (generated from them).

**webgpu-medium** (machine CPU during the runs: mean 44.5 %, max 93.1 %; min free RAM 41 MB)

| View | before p50 / p95 / p99 | after p50 / p95 / p99 | Δ p50 | Δ p95 | floor p50 / p95 | draws before → after (floor) | CPU p50 before → after | GPU p50 | active meshes before → after | per other character before → after (p50) |
|---|---|---|---|---|---|---|---|---|---|---|
| close | 76.1 / 131.7 / 168.9 | **46.8 / 69.1** / 85.2 | -38.5 % | -47.5 % | 17.5 / 28.6 | 1129.8 → 713.3 (232.8) | 71.8 → 43.3 | 2.4 / 2.4 | 1016 → 582 | 418.6 → 209.3 µs |
| mid | 70.2 / 109.5 / 138.2 | **45.5 / 69.2** / 82.9 | -35.2 % | -36.8 % | 18.6 / 29.7 | 1436.1 → 728.5 (232.5) | 65.8 → 42.7 | 2.4 / 2.5 | 1315 → 581 | 368.6 → 192.1 µs |
| far | 69.8 / 93.4 / 105.4 | **39.7 / 62.7** / 72.5 | -43.1 % | -32.9 % | 15.2 / 23.9 | 1333.6 → 604.5 (149.4) | 64.7 → 36.5 | 2.5 / 2.5 | 1271 → 484 | 390 → 175 µs |

**webgl2-medium** (machine CPU during the runs: mean 88.5 %, max 100 %; min free RAM 10 MB)

| View | before p50 / p95 / p99 | after p50 / p95 / p99 | Δ p50 | Δ p95 | floor p50 / p95 | draws before → after (floor) | CPU p50 before → after | GPU p50 | active meshes before → after | per other character before → after (p50) |
|---|---|---|---|---|---|---|---|---|---|---|
| close | 100.2 / 139 / 161.1 | **68.7 / 111.9** / 157.2 | -31.4 % | -19.5 % | 28.1 / 44.1 | 1119.4 → 722.5 (231.1) | 92.5 → 63.4 | 2.2 / 2.2 | 1003 → 553 | 515 → 290 µs |
| mid | 99 / 123.2 / 143.4 | **71.1 / 107.7** / 125.7 | -28.2 % | -12.6 % | 29.1 / 49.9 | 1448.5 → 686.5 (227.4) | 91.6 → 66.3 | 2.3 / 2.3 | 1327 → 562 | 499.3 → 300 µs |
| far | 90.6 / 116.1 / 137.5 | **62.8 / 87.9** / 100.5 | -30.7 % | -24.3 % | 25.4 / 41.4 | 1317.2 → 564.6 (141.5) | 84.4 → 56.6 | 2.3 / 2.3 | 1260 → 460 | 465.7 → 267.1 µs |

**webgpu-low** (machine CPU during the runs: mean 56.4 %, max 100 %; min free RAM 126 MB)

| View | before p50 / p95 / p99 | after p50 / p95 / p99 | Δ p50 | Δ p95 | floor p50 / p95 | draws before → after (floor) | CPU p50 before → after | GPU p50 | active meshes before → after | per other character before → after (p50) |
|---|---|---|---|---|---|---|---|---|---|---|
| close | 57.9 / 100.8 / 115.5 | **43.5 / 64.9** / 77.9 | -24.9 % | -35.6 % | 24 / 33 | 1112.5 → 716.9 (296.4) | 54.2 → 41.2 | 0.7 / 0.8 | 1102 → 636 | 242.1 → 139.3 µs |
| mid | 46.8 / 71.8 / 80.1 | **37.2 / 50.6** / 57.7 | -20.5 % | -29.5 % | 14.7 / 20.6 | 1396.4 → 792.7 (313.3) | 44.1 → 34.9 | 0.8 / 0.9 | 1353 → 654 | 229.3 → 160.7 µs |
| far | 49.6 / 87.7 / 101.3 | **43.8 / 82.4** / 155 | -11.7 % | -6 % | 12 / 24.1 | 1369 → 703.3 (241.2) | 46.3 → 38.8 | 0.8 / 0.8 | 1339 → 596 | 268.6 → 227.1 µs |

**Read with the machine state in mind.** The WebGL2 run had the worst of it (mean 88.5 % CPU, free RAM down to 10 MB
while another helper's job ran), which inflates its absolutes and its p95. Two other interleaved runs agree on the
direction and size: the first full run of the day (WebGL2 Medium before → after p50 −17 / −30 / −30 % close / mid /
far, at 54 % machine CPU) and a WebGL2 A/B after the last fix (close −21 % p50 / −14 % p95, mid −22 % / −19 %,
42 % machine CPU; `work/tmp/charbench/throttle/`). The GPU frame (timestamp queries) is 2.2–2.5 ms on Medium and
0.7–0.9 ms on Low in every variant: **the frame is CPU-bound**, as in every gate since wave 9. "Low" here is the Low
preset of the new look (no sun shadows, the animation LOD on), so the P0 rules apply there too; Classic is untouched.

### 1.3 Where the frame goes

Segments (mean ms per frame, mid view, median of rounds): 
- before: animations 9.1, game logic 7.7, render targets (shadows) 2, active mesh eval 15.4, main draw 36, post + after 0.2; posed/frame 119.9; outfits 0
- after: animations 5.6, game logic 6.8, render targets (shadows) 1.7, active mesh eval 11.1, main draw 19.3, post + after 0.2; posed/frame 74.2; outfits 136
- floor: animations 3.8, game logic 4.3, render targets (shadows) 0.6, active mesh eval 2.7, main draw 6.3, post + after 0.2; posed/frame 56.8; outfits 0

(WebGPU Medium, mid view.) The other characters are **73 % of the frame before P0** (70.2 − 18.6 of 70.2 ms at p50)
and **59 % after**. A JS CPU profile of the after state (unminified build, 100 players, `--profile mid`): drawing
33 % of the samples (Babylon's per-draw submission, `_RenderSorted`, `bindForSubMesh`, `writeBuffer`), active-mesh
evaluation 21.5 % (of which skeleton preparation 8.2 % and world matrices 5.5 %), animations 13 % (Babylon's
animatables and key interpolation), the world's per-frame logic 13.5 % (entity updates, effects of the 30 fights,
labels ≈ 1.5 %), the rest program and GC [confirmed: `work/tmp/charbench/prof1/webgpu-medium-mid.top.txt`].
Name tags are not the problem at 100 players (≈ 1.5 % with their layout), so P0 left them alone.

---

## 2. The target architecture [decision]

### 2.1 The frame budget at 100 players

Dev PC, Medium, a quiet machine, p95 ≤ 16.7 ms on both backends:

| Part | Budget | Basis |
|---|---|---|
| World, sky, post, HUD, labels of nobody (the floor) | ≤ 7.0 ms | the empty-plaza gate rows (5.8 ms WebGPU / 4.1 WebGL2 on a quiet machine, NIGHT_LOG) + the plaza's NPCs and town life |
| **Every other character together (100 players + the monsters and NPCs on screen)** | **≤ 7.0 ms CPU**, ≤ 4.0 ms GPU | ≈ 70 µs a character on average: LOD0 ≈ 0.30 ms × 8, LOD1 ≈ 0.08 ms × 24, the crowd ≈ 0.025 ms × 70 (CHAR_PERF §10.2's measured T1/T2 costs) |
| The own character (cloth, jiggle, full rate) | ≤ 0.4 ms | |
| Headroom (GC, effects in a fight, a slower CPU) | ≥ 2.3 ms | the fight's effects are measured separately (BACKLOG item 9) |

A machine whose single core is ≈ 0.7× the dev PC's (an Apple M1, a mid laptop) reads ≈ 20 ms on this budget; it keeps
60 fps by Medium's LOD distances shrinking (the LOD0 count 8 → 4, the crowd from 18 m) [projected].

### 2.2 One character = one mesh, one material, a few draws

| Tier | Who (Medium) | Mesh | Draws (main + shadow) | Animation | Shadows |
|---|---|---|---|---|---|
| **LOD0** | own, target, hovered, party (in the cap), then the nearest, **≤ 8** within 12 m (High 12, Ultra 20) | the full base with its outfit merged in at load: one skinned mesh, one material reading the texture arrays; hair cards and the weapon as their own draws | ≤ 3 + 2 | full rate, Babylon GPU bones, crossfades, layers, cloth and jiggle | every cascade |
| **LOD1** | the next **≤ 24** within 25 m | LOD1 mesh (≤ 8 k triangles), hair baked in, one material | 2 + 1 (weapon kept) | 30 Hz (60 fps) / 20 Hz floor; clip snap (P0) | cascade 0 |
| **LOD2: the crowd** | everyone else on screen (players, monsters, NPCs) | the crowd mesh (≤ 2 k triangles) per outfit, **thin-instanced** (CHAR_PERF T2: VAT bone texture, row interpolation, a crossfade, the arm layer) | 1 per (outfit, LOD) batch, not per character | on the GPU (a clip clock on the CPU) | blob (Medium), cascade 0 (High) |
| **Impostor** | beyond 60 m (High+ draw distance) | an octahedral impostor per (base, outfit) with 8 animation frames | 1 for all | GPU | none |

Promotion and demotion never pop (the same pose: CHAR_PERF §2.2), ≤ 2 promotions a frame, 3 m / 1 s hysteresis.
Low keeps today's path (the Low guard) until P3's LOD1 assets exist, then Low = LOD1 for everyone near + LOD2.

### 2.3 Per-preset budgets

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| LOD0 count / range | 0 (LOD1 near) | 8 / 12 m | 12 / 15 m | 20 / 20 m |
| LOD1 count / range | 16 / 20 m | 24 / 25 m | 32 / 35 m | 40 / 45 m |
| LOD0 triangles (body + outfit + hair) | – | ≤ 30 k (12 k + 14 k + 4 k) | ≤ 30 k | ≤ 40 k (hair 10 k) |
| LOD1 / LOD2 / impostor triangles | 8 k / 2 k / 2 | 8 k / 2 k / 2 | same | same |
| Bones (skinned) | 43–45 | 43–45 + 4 jiggle (LOD0) | same | same + cloth chains |
| Influences per vertex | 4 | 4 | 4 | 4 |
| Texture arrays (BC7 / ASTC, mips) | LOD1 512² | LOD0 1024², LOD1 512², crowd 256² | LOD0 2048² | LOD0 2048² |
| Maps | albedo | albedo, normal, ORM (LOD0), albedo + normal (LOD1) | same | same + detail normal |
| Character draws (100 players, main + shadow) | ≤ 90 | ≤ 140 | ≤ 190 | ≤ 260 |
| Skinned triangles at 100 players | ≈ 0.3 M | ≈ 0.6 M | ≈ 0.8 M | ≈ 1.2 M |
| Cloth sims / jiggle actors | 0 / 0 | 5 / 8 | 10 / 12 | 20 / 20 |
| Character VRAM (resident sets) | ≤ 64 MB | ≤ 256 MB | ≤ 512 MB | ≤ 768 MB |

### 2.4 Textures are shared; colours are parameters [decision]

- **Texture arrays per gender and tier**: one layer per base (skin), per outfit set, per hairstyle; each vertex of
  the merged mesh carries its layer (one flat varying; CHAR_PERF §2.3's crowd array generalised). One material and
  one pipeline per (gender, tier): a character costs **no texture memory of its own**, and the crowd's batches share
  the same arrays.
- Skin tone, eye colour, hair colour, dyes (later) and markings (later) are **per-instance parameters** read by the
  material (skin: a tone in a 24-entry palette plus a fine shift; hair: root and tip colours), so 100 players in
  100 colourways are still one material.
- Streaming: an outfit set's layers load with its first wearer (KTX2 per layer, the terrain arrays' path,
  `texture-compressed.ts`), LRU-evicted past the preset's VRAM cap.

### 2.5 GPU skinning

Babylon's bone-texture skinning for LOD0/LOD1 (as today); the VAT for the crowd. Compute skinning, workers and
GPU keyframe evaluation stay rejected for the reasons CHAR_PERF §3.2 measured: the CPU half is animation and per-mesh
work, which the tiers remove.

---

## 3. P0: the speed foundation (this job)

### 3.1 Rules added [confirmed: code]

Every rule sits behind a LAB switch in `apps/game/src/world/char-lod.ts` (`CHAR_LOD`, on by default; the bench turns
them off for `before`) and is decided by the G1 crowd budget (`world/crowd-budget.ts`, its plan every 250 ms), so
**nothing changes within 15 m of the camera** (`OUTFIT_FROM_M` = CLOSE_M), nothing changes with fewer than 10 others
near, and nothing changes on the Classic path (the rules ride on the animation LOD, which Classic has off).

1. **The outfit merge** (`three/outfit-merge.ts`, `three/outfit-atlas.ts`, `CharacterActor.setOutfitMerge`): an
   other character beyond 15 m in a crowd draws its body, hair and every worn armour piece as **one skinned mesh with
   one material** whose albedo is a 512² atlas of the parts' own textures, built on the GPU (one copy pass per
   texture, alpha forced to 1 for opaque parts, sRGB-buffer textures re-encoded, 4-texel edge padding, mips), so it
   works for retail PNG/WebP and remaster KTX2 textures alike. Weapons and shields stay on their sockets (their glow
   and seal looks are per mesh). Parts on a skeleton of their own, blended materials and tiling UVs stay apart.
   Characters with the same parts share the atlas and material (≤ 160 atlases, freed 30 s after their last user).
   The merge is made again when the shown parts or their textures change (Berserk hiding the hair, the remaster's
   texture swap: checked every 1–2 s per character, staggered; a re-dress drops it at once); opacity, the hover highlight and the cull reach the merged mesh. ≤ 3 new merges per plan.
2. **The far clip snap** (`CharacterActor.snapClips`): the same far characters start clips without the clip-change
   blend, and a blend no longer forces them to the every-frame pose rate. In a 100-player fight most of the crowd
   was changing clips often enough to sit at the full rate almost all the time.

Also: the bench itself (§1.1), and two LAB-only aids that are off in the game: `CHAR_LOD.outfitNear` (merge everyone,
for the look check) and the floor variant.

### 3.2 What each rule bought

| WebGPU Medium, mid view, 100 players (2 interleaved rounds, a busier machine: 62.6 % CPU) | p50 | p95 | draws | actors posed per frame |
|---|---|---|---|---|
| before (HEAD) | 81.1 | 103.9 | 1,226 | 121 |
| the outfit merge alone (`only-outfit`) | 65.2 (−20 %) | 92.9 (−11 %) | 647 | 112 |
| the outfit merge + the far clip snap (`after`) | 58.7 (−28 %) | 79.7 (−23 %) | 650 | 91 |

[confirmed: `work/tmp/charbench/snap1/`] The merge takes the draws and the meshes (a far character's 6–9 skinned
parts become one; 136 characters merged, ≈ 107 distinct atlases for 136 outfits, ≈ 150 MB of VRAM at most); the snap
takes the forced every-frame pose updates. One fix came from the bench itself: the first version re-read every merged
character's parts on every plan (4 Hz × 136), which showed as a 1–2 ms spike every quarter second in the WebGL2 p95;
the check now runs every 1–2 s per character (staggered), and a re-dress drops the merge at once anyway.

### 3.3 The look check [confirmed: screenshots]

`characters/bench-webgpu-medium-{close,far}-{before,after,floor}.png` (Dropbox, this track's folder): the same frozen
crowd (the bots stopped for the shots) before and after. A zoomed pair with **every** character merged
(`outfitNear`, `--shot-near`), WebGPU and WebGL2, shows a merged character next to the same character drawn from its
parts with no visible difference at 6–10 m (textures, cut-outs, two-sided parts, skinning) [confirmed: the crops in
`work/tmp/charbench/look2/`, and the WebGPU pair of this job's debug run]. One bug found and fixed on the way: on
WebGPU a render target's `vUV.y` runs the other way, so the copy pass now places texels by the fragment's own
position (row 0 = the texture's first row on both backends).

### 3.4 What P0 could not do (the gap that needs the new models)

After P0 the 100-player plaza is still **2.7–4× over** the 16.7 ms line on this machine (≈ 1.7–2.5× after the
machine-load correction CHAR_PERF used, × 0.62 for a quiet machine [projected]). What is left, and why the retail
characters cannot close it without changing how they look up close:

1. **Draws: ≈ 4 per character** (the merged body, the weapon, often a shield, the shadow casters, the parts of the
   5–15 characters within 15 m; at the mid view 125 of the 234 remaining character meshes are weapons and shields) at ≈ 25 µs of CPU each. Within 15 m a retail character must stay 6–9 parts (the
   user's rule), and weapons carry per-mesh glow and seal looks. The new bases are **one mesh and one material by
   construction**, and the crowd tier draws **one batch per outfit for everyone wearing it** (CHAR_PERF measured
   ≈ 0.04 ms per crowd character, against ≈ 0.19 ms now).
2. **CPU animation**: ≈ 74 actors posed per frame (bone matrices, world matrices, the bone-texture upload, the key
   interpolation of 86 tracks each): 11 ms of evaluation + 5.6 ms of animations. The crowd tier's clip clock moves
   the crowd's skinning to the GPU (a VAT row per frame), which only works for meshes built for it (one layout, one
   material, the arrays of §2.4): the new bases.
3. **The per-frame world logic** of 140 entities and 30 running fights (6.8 ms): entity interpolation, hit effects and
   damage numbers. Partly character work (the crowd tier needs no per-frame label anchor or bone read), partly the
   final performance pass's effects budget (BACKLOG item 9).

Projected with the P1 renderer [projected, from CHAR_PERF §10.2's measured unit costs on a quiet dev PC]: floor ≈ 7 ms +
8 LOD0 × 0.30 + 24 LOD1 × 0.08 + ≈ 110 crowd × 0.03 ≈ 14.6 ms p50, under the line with ≈ 2 ms to spare. P1's gate
measures it.

### 3.5 P1a: the crowd tier on the retail characters [confirmed: code, bench]

Built without new art (`CHAR_LOD.crowdTier`, on by default; `three/crowd-vat.ts`, `three/crowd-tier.ts`,
`CharacterActor.setCrowd`, `world/crowd-budget.ts`):

- **Who**: in a crowd (≥ ANIM_FROM others near), every other character outside the **close set** (`closeSet`: the
  CLOSE_COUNT = 8 nearest within CLOSE_RANGE_M = 12 m, kept until 15 m / rank 10; never own, target, hovered, party).
  The close set is drawn exactly as before. Riders, carriers, companions, faded or highlighted actors, hidden weapons
  and Berserk (`holdCrowd`) stay on the P0 path.
- **Draw**: one thin instance of an **outfit batch** (body, armour, hair, weapon, shield in one mesh; weapons rigidly
  bound to their socket bone, so P0's separate weapon draws are gone), skinned on the GPU from a **VAT baked in the page**
  from the actor's own clips (half float, 30 rows/s, lazily per clip, shared per skeleton signature: 2–3 player VATs
  + one per monster/NPC skeleton, ≈ 16 MB total at 100 players). Loops advance on the GPU (no write while a clip
  plays); one-shots get their row from the CPU. Batches of one VAT share **atlas pages** (2048², 16 outfit slots of
  512²) and so one material per page, frozen and thawed every 2 s, which skips Babylon's per-draw rebind. Monsters
  and NPCs keep their own material: 20 Mangnyang are one draw.
- **Clips**: the actor's groups still run (end events, bone readers) but step at CROWD_STEP_HZ = 5; its glTF roots are
  disabled, so nothing of it is an active-mesh candidate. No shadow of its own (a blob).
- **Weapon look at distance**: + level glow and seal tint and rim as a per-instance code (`CrowdItemPlugin`, no
  varying: the item's atlas u carries it). Rare and +7 items keep their effects layer: their meshes follow the instance
  (world matrix from the VAT) and `pickMotes`/`pickGlinting` accept crowd-drawn meshes.

**Bench** (one round, 300 frames, WebGPU Medium, 15 s settle, interleaved; machine mean 52 % CPU, free RAM down to
69 MB while the other helper ran, so absolutes are high; `work/tmp/charbench/p1a-try3/`), p50 / p95 ms:

| view | p0 (HEAD) | P1a | floor (no crowd) | draws p0 → P1a |
|---|---|---|---|---|
| close | 76.1 / 107.8 | **47.6 / 72.8** (−37 %) | 28.5 / 47.8 | 706 → 573 |
| mid | 55.0 / 86.2 | **35.9 / 56.8** (−35 %) | 28.4 / 44.8 | 665 → 487 |
| far | 48.7 / 76.4 | **23.8 / 46.6** (−51 %) | 25.8 / 65.3 | 499 → 315 |

Posed actors per frame 88 → 29 (mid). The crowd now costs ≈ 7.5 ms over the floor at the mid view for ≈ 140 others
(≈ 54 µs each, under §2.1's 70 µs); the rest of the gap to 16.7 ms is the floor on this loaded machine. An earlier
quieter pair (`p1a-try2`, before the pages): mid 42.4 → 28.4 with a 21.0 floor. Not done: WebGL2 and Low runs, row
interpolation and crossfades, impostors (draws per batch are already 1), the clip-clock replacement of Babylon's
groups. Tests: `apps/game/test/crowd-tier.test.ts`.

---

## 4. The base models

### 4.1 Topology and budgets [decision]

| | Female base | Male base |
|---|---|---|
| Height at Height 2 | 1.72 m (the retail woman) | 1.81 m (the retail man) |
| LOD0 body incl. head, hands, feet | ≤ 12 k triangles (head ≤ 4 k, hands ≤ 1 k each) | same |
| Under clothing | the body is split into **regions** (head, neck, torso upper/lower, upper arm, forearm, hand, thigh, calf, foot); an outfit declares the regions it covers and those submeshes are not drawn (no hidden triangles, no z-fighting) | same |
| UVs | one 0–1 layout per base, the same layout for every skin layer; the face gets 40 % of the texture | same |
| LOD1 / LOD2 | 4 k / 1 k body triangles (outfit and hair merged in) | same |
| Retail reference | 1,534 triangles, 9 parts (`chinawoman_adventurer`) [confirmed: sidecar stats] | 1,330, 9 parts |

### 4.2 The skeleton: the retail one, untouched [decision]

The bases are bound to **the retail bind pose of `europewoman_skel` / `europeman_skel`** (the Chinese characters'
skeletons: 45 / 43 joints, `Bip01 …`, `Bone01–02` on the woman, `cloak01–04` on both) [confirmed: the sidecars'
joint lists]. Joint names, hierarchy, rest transforms and limb lengths stay exactly as retail, so every retail BAN
clip (≈ 225 per body, the weapon packs, the movement pack, emotes, Berserk, riding on the `saddle` joint) plays
unchanged and weapons hang on the same sockets (the SRO socket rule). Body shape is morphs, never bone lengths:
a bone-length change would slide feet and move hands off the weapon grips. Height stays the root scale
(0.94–1.06, CHARACTER_SCALE). The retail Volume (radial bone scales) is replaced by the body sliders (§5.2).

### 4.3 Extra bones

- **Jiggle** (§9.2): `chest_L`, `chest_R` (children of `Bip01 Spine1`) and `glute_L`, `glute_R` (children of
  `Bip01 Pelvis`), appended after the retail joints so retail clip indices are unchanged; no retail clip animates
  them (they rest at their bind pose plus the spring's offset).
- **No face bones**: retail has no facial animation; the face is shaped by morphs at creation. Blinks (later) are a
  morph pair driven by a timer.
- Cloth chains (CLOTH.md's auto-rig) live in the cloth garment's own glb, as CLOTH decided.

### 4.4 Morph targets

≈ 40 shapes per base, authored in Blender on the LOD0 body (and carried to LOD1/LOD2 by surface transfer):
9 body shapes (§5.2), 12 face presets (whole-face shapes) and 22 face sliders. **Applied once, on the CPU, when a
character's look is set** (baked into its own vertex buffer for LOD0 and LOD1: no per-frame morph cost; ≈ 20 k
vertices × 32 B = 0.64 MB a character, ≈ 64 MB for 100 near and mid characters [projected]). The crowd tier (LOD2)
reads 4 body deltas from a small texture with per-instance weights (breast, buttocks, hips, weight); face sliders
do not exist at that size.

---

## 5. The creator

### 5.1 The screen [decision]

Character creation gets the creator; character select gets **"Re-customise"** for characters still on a retail body
(once, then the button goes). Layout: the character on a turntable in the studio light (the stage's existing
`studio-env.ts`), tabs **Body / Face / Skin / Eyes / Hair / (Markings, later)**, a camera that frames the part being
edited, randomise per tab, undo, and a preview strip of the character in garment, protector and armour of the
current level. All in the UI kit (`ui/kit/**`); every control keyboard- and gamepad-reachable.

### 5.2 Sliders, ranges, defaults [decision]

Every slider is an integer 0–100 on the wire (50 = the base's neutral shape unless stated).

| Slider | Female: range (default) | Male: range (default) | Drives |
|---|---|---|---|
| Height | 0–4 (2) | 0–4 (2) | root scale 0.94–1.06 (as today) |
| Weight (slim → heavy) | 0–100 (40) | 0–100 (45) | morph pair |
| Muscle | 0–100 (30) | 0–100 (45) | morph |
| **Breast size** (small → very large) | 0–100 (35) | 0–100 (20) (pectorals) | morph pair (−/+) |
| **Buttocks** (small → large) | 0–100 (40) | 0–100 (35) | morph pair |
| **Hip width** (narrow → wide) | 0–100 (45) | 0–100 (40) | morph pair |
| **Waist** (narrow → wide) | 0–100 (40) | 0–100 (45) | morph pair |
| **Thigh** (slim → full) | 0–100 (40) | 0–100 (40) | morph pair |
| Shoulders (narrow → broad) | 0–100 (40) | 0–100 (55) | morph pair |

The extremes are authored to stay believable with the Chinese armour silhouettes (the dream-loop judge scores the
extremes, §11); "very large" is the 100 end of the breast slider, and the server clamps to 0–100 whatever a client
sends. Face: **12 presets** per base (from the retail faces' character: the 13 men and 13 women of the roster give
the first 12 their look, so a re-customising player finds a face near their old one) and **22 sliders** (jaw width,
chin length / width, cheekbones, cheek fullness, eye size / spacing / height / tilt / depth, brow height / angle,
nose width / length / bridge / tip, lip fullness upper / lower, mouth width, ear size / angle), each −50…+50 around
the preset. Skin: a 24-tone palette + a fine shift. Eyes: 16 colours. Hair: 12 styles per base at launch (P1: 2),
root and tip colour from a 32-colour palette, brows (4 shapes). Markings: later (§14).

### 5.3 Data: the appearance blob [decision]

- **Shared** (`packages/shared/src/look.ts`, new): `Look v1` = `{ v: 1, base: 'f' | 'm', height, body[9], face:
  { preset, sliders[22] }, skin: { tone, shift }, eyes, hair: { style, root, tip }, brows, markings: [] }`, a pure
  `parseLook()` that clamps and rejects (unknown version, a style the base does not have), `encodeLook()` /
  `decodeLook()` to **64 bytes** (base64url, 88 characters) for the wire. Tests: round trip, every bound, garbage.
- **DB** (one additive migration): `characters.look TEXT` (the JSON, NULL = still a retail body) and
  `characters.look_v INTEGER NOT NULL DEFAULT 0`. `height` keeps its column (the root scale); `volume` stays for old
  rows only.
- **Wire**: `charCreate.look?`, a new `charLook { id, look }` (the one-time re-customise from character select;
  refused once `look_v` ≥ 1, and in the world), `CharacterSummary.look?`, `EntityState.look?` (the 88-character
  string), `appearance.look?` when it changes. A player without a look is drawn as today's retail body until P3
  closes the transition (§12).
- **Migration of existing characters**: nothing is lost (name, level, gear, skills, gold, guild). At the first login
  after the switch, a character with `look_v = 0` opens the creator pre-filled from its retail body: gender, Height,
  the retail face's preset, Volume → Weight (0–4 → 20 / 30 / 40 / 55 / 70), a skin tone and hairstyle near the
  retail one. Saving sets `look_v = 1`. The server keeps answering for retail bodies until P3 so nobody is locked out.

### 5.4 Outfits follow the body [decision]

Every outfit mesh carries **the same body morph targets, by name** (`body_breast_plus`, `body_hips_minus`, …),
authored in Blender per outfit: a Surface Deform / shrinkwrap transfer from the base's shapes, then hand-corrected at
both extremes (plates stay rigid and move, cloth stretches). The character's slider values drive the body and its
outfit together, in the same CPU bake. Face morphs drive head items (hats, helmets, masks) the same way where they
touch the head. The converter fails an outfit that lacks a body shape or whose body pokes through it by more than 2 mm
in a covered region at any slider's 0 or 100 (and at the four corner combinations of breast × hips, weight × muscle).

---

## 6. Hair [decision]

- **Cards**, not strands: LOD0 ≤ 4 k triangles (10 k on Ultra), alpha-tested with hashed alpha under TAA (no
  sorting, no blending), a scalp cap mesh under it so thin cards never show the skull.
- **Shader**: an anisotropic two-lobe specular (Kajiya-Kay style: a shifted primary lobe and a tinted secondary) as a
  PBR plugin on the hair layer, a flow-map tangent per card, root-to-tip colour from the look; GLSL and WGSL like
  every plugin here; ≤ 2 extra inter-stage variables (the 16-varying guard).
- **LOD1**: the hair baked onto a shell (≤ 800 triangles) in the character's LOD1 mesh; LOD2: in the albedo.
- **Head items** hide the hair by region (`hair_top`, `hair_back`, `hair_full`) as retail's hide rules do; Berserk's
  hwan hair keeps its rule.
- Tassels and long hair get a CLOTH chain (§9) on LOD0 only.

## 7. Skin [decision]

PBR (the character surface plugin's skin class) plus: a **pre-integrated / wrap diffuse** term for the soft terminator,
**thin translucency** on ears and fingers from a thickness map (ORM's spare channel), a **detail normal** tiled
over the skin on High+, and the tone parameter applied in linear space before lighting. LOD0 and LOD1 only (the crowd
uses the plain material). Cost target: ≤ 0.15 ms GPU at 1080p for 8 LOD0 characters on the dev PC.

---

## 8. Outfits

### 8.1 Retail item codes → new outfit sets [decision]

The level cap is 25 (The Climb), so the wearable Chinese armour is **degrees 1–3 × 3 classes × 2 genders × 6
slots**, each in grades A/B/C [confirmed: the bench's gear index found weapons and armour of degrees 1–3 only].
The mapping is data, `content/outfits.json`:

```
{ "ITEM_CH_W_LIGHT_02_*": { "set": "protector-2", "base": "f" }, … }
```

- **One set per (class, degree, gender)** = 18 sets, each a full outfit (head, shoulders, chest, legs, hands, feet
  pieces) on one atlas layer group; the grades A/B/C are **colour variants** of the set (a palette row each, the dye
  path), not separate meshes.
- A character's drawn outfit = the pieces of its worn items; mixed sets work because every piece of every set is cut
  on the same region boundaries of its base (neck, shoulder, elbow, wrist, waist, knee, ankle).
- Named and Climb sets (W15-A…D in CLIMB §4.3) and costumes (WARDROBE's costume slots) are extra rows.
- Weapons keep their retail models until Arsenal; they hang on the same sockets.
- NPC townsfolk keep the VAT townsfolk (WARDROBE's civilian clothes plan stands for them).

### 8.2 Fitting both bases

Each set is made **twice** (female and male base), from one concept sheet per class and degree, so the pair reads
as one set. Every piece is weighted to the retail skeleton (data transfer from the base body, then corrected at the
shoulders, hips and knees in the retail clips' extreme poses: RUN, the skill clips with the widest swings, SIT, the
horse). The converter checks the bind pose against the base, 4 influences, the morph names (§5.4), the region tags,
UVs in [0, 1] (the array layer), the triangle budget, and plays the clip list for poke-through on a sample of frames.

### 8.3 Dyes (later) [decision]

WARDROBE's dye model (R/G/B mask, per piece) stays; with arrays and per-instance parameters a dye is one palette row
per piece and costs no draw. Not before P3.

---

## 9. Cloth and jiggle

### 9.1 Cloth

CLOTH.md's solver (verlet chains, fixed 60 Hz, capsules, deviation rendering), auto-rig and tiers stand, with T0/T1
read as **LOD0**: Medium 5 simulated actors, High 10, Ultra 20, off on Low. The new outfits are authored with their
chains in mind (robes, skirts, panels, tassels).

### 9.2 Jiggle [decision]

- **Bones**: chest L/R (amplitude scaled by the breast slider: 0 at 0, 1 at 100) and glute L/R (× 0.4, by the
  buttocks slider).
- **Step**: one damped spring per bone (position offset in the parent's frame, k and c per bone, the parent's
  acceleration as the drive, a 2.5 cm clamp), in the **same fixed 60 Hz step as cloth** (CLOTH §6.2) so both share
  the anchors and the reset rules (a teleport or a promotion resets them).
- **Armour stiffens it**: the chest piece's class scales the amplitude (garment 1.0, protector 0.55, armour 0.2);
  no chest piece 1.0.
- **Who**: LOD0 only, within 20 m, Medium 8 / High 12 / Ultra 20, off on Low, Options → Graphics → **"Body physics"**
  (on by default on Medium and up).
- **Cost** [projected from CLOTH §7's measured step]: 4 springs ≈ 2 µs + the 4 bones in the bone texture ≈ 3 µs per
  actor and frame ⇒ ≤ 0.05 ms for 8 actors on Medium, inside §2.1's LOD0 budget. The crowd and LOD1 show the body at
  rest (no bones animated).

---

## 10. The asset pipeline

```
Higgsfield concept sheet ─▶ dream-loop ─▶ Blender (MCP) ─▶ converter ─▶ glb + KTX2 layers ─▶ game
 (front / side / back,       (target image → build →      (retopo to budget, UVs     (`pnpm sro outfit`:       (/out-opt/,
  per set and class)          render → independent judge    on the base layout, rig    validation, LODs,         texture arrays,
                              scores Composition,           to the retail skeleton,    array layers,             the bench at 100)
                              Lighting, Materials, Details  morphs, regions, LODs,     budgets)
                              out of 10 → iterate to ≥ 8    bake maps, export)
                              on every axis)
```

- **Concept** (Higgsfield): one sheet per base and per (class, degree) set, turnaround views, the Chinese style
  bible (a page of references the user approves first, §14).
- **dream-loop** (https://github.com/achimala/dream-loop): the target image → a Blender build → a render from the
  concept's camera → the independent judge's four scores; **accept at ≥ 8 on all four**, else iterate (≤ 6 rounds,
  then a person looks). The judge also scores the slider extremes (§5.2) and LOD1 at 20 m.
- **Blender via MCP**: the base file per gender holds the retail skeleton (imported from the converted glb, never
  edited), the region-split body, the morphs; each set is a file that links the base. A scripted export writes the
  glb (named meshes, region and layer tags in extras) and the maps.
- **Converter** (`packages/convert`, a new `outfit` verb): validation as §8.2, LOD1/LOD2 generation checks, the crowd
  mesh and VAT for the crowd tier, KTX2 layers through texpipe, the manifest rows.
- **In game**: the bench at 100 players for every new base and set (the gate), plus a contact sheet of the set on
  both bases at three slider extremes.

---

## 11. Build plan

| Phase | What | Gate |
|---|---|---|
| **P0** (done, this job) | the bench; the baseline; the outfit merge and the far clip snap; this plan | §1.2 numbers; tests; nothing changes within 15 m |
| **P1** pilot | **renderer**: the LOD tiers of §2.2 for the new bases (LOD0 merged mesh + arrays, LOD1, the VAT crowd tier with clip clock, promotions), the look blob and its migration, the creator screen with body (all 9), face presets (4) and 6 sliders, skin and eyes; **art**: the female base, 1 outfit (garment-1), 2 hairstyles, judged ≥ 8 | **100 players at ≤ 16.7 ms p95 on WebGPU and WebGL2 Medium on the dev PC** with every bot on the pilot base; the jiggle-free look at all slider extremes |
| **P2** | the male base, the full face set, hair shader polish | the same gate, mixed genders |
| **P3** | every set by gear tier (degree 1 → 3; garment, protector, armour; both bases), Low on LOD1, the switch: retail bodies retire, everyone re-customises once | the gate with the bench's mixed gear; a contact sheet per set |
| **P4** | cloth on the new outfits, jiggle, dyes | cloth on − off ≤ 0.35 ms (CLOTH's gate), jiggle ≤ 0.05 ms, the 100-player gate holds |

---

## 12. What this absorbs from the drafts

| Draft | Kept | Changed |
|---|---|---|
| CHAR_PERF.md | the bench method (interleaved variants), the three tiers (now LOD0 / LOD1 / crowd), the VAT crowd tier (T2) with row interpolation, crossfade, arm layer, sockets, the clip clock, lazy animation groups, the near cap, promotions | 100 players, not 20; the near cap is 8 on Medium (was 4) because LOD0 is one draw now; the crowd's textures are the shared arrays of §2.4 |
| WARDROBE.md | dyes, costume slots, the civilian clothes for townsfolk, one material per set | new sets are made for the new bases; Meshy retextures of retail meshes are out |
| CLOTH.md | the solver, the auto-rig, tiers and costs | tiers read as LOD0; jiggle joins its step |

---

## 13. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Keep the retail skeletons exactly (joints, bind pose, limb lengths) | every retail clip, skill, emote, Berserk and ride keeps working |
| D2 | Body shape by morphs, height by root scale, never bone lengths | bone-length changes slide feet and break weapon grips |
| D3 | One skinned mesh and one material per character at every LOD; hair and weapon as their own draws only at LOD0/LOD1 | draws are the measured cost (§1.3) |
| D4 | Textures in shared per-gender arrays; colours as parameters | 100 colourways cost no memory and no extra material |
| D5 | Three LODs + the VAT crowd + impostors, caps per preset (§2.3) | 100 players cannot all be full characters on a CPU-bound frame |
| D6 | Creator morphs baked on the CPU at look time (LOD0/1), 4 body deltas on the GPU for the crowd | no per-frame morph cost |
| D7 | Outfits carry the body morphs by name; the converter checks poke-through at the extremes | clothing never clips at any slider value |
| D8 | Jiggle = 4 spring bones in cloth's fixed step, LOD0 only, armour-stiffened, an Options toggle | cheap, believable, off where it cannot be seen |
| D9 | The appearance blob: 64 bytes on the wire, JSON in the DB, validated by one shared parser | the server is the authority; old clients ignore it |
| D10 | Existing characters re-customise once, pre-filled from their retail body | the user's rule; nobody loses anything |
| D11 | 18 sets (class × degree × gender) for the cap-25 game; grades as colour variants | the wearable range is degrees 1–3 |
| D12 | P0's outfit merge only beyond 15 m, in a crowd, never for own/target/party | the user's "keep anything visible up close unchanged" |
| D13 | P0's far clip snap for the same characters | a blend held most of the crowd at full pose rate |
| D14 | The bench is part of the repo (`pnpm charbench`), headless by default, `--serve` for a real browser | reproducible numbers for every phase's gate |

## 14. For the user to decide later (defaults used meanwhile)

| # | Question | Default |
|---|---|---|
| U1 | The style bible: approve 6–10 reference images for the Chinese look before any concept work | none started |
| U2 | How far "very large" goes (the 100 end of breast and buttocks), and whether the extremes are limited by armour class | the judge's believability call at ≥ 8, same range for every class |
| U3 | The skin-tone palette (24 tones) and whether markings (tattoos, scars, face paint) come in P2 or later | a natural palette; markings after P3 |
| U4 | Should players be able to keep the retail look during the transition (P1–P3)? | yes, until P3 switches everyone |
| U5 | Should the 26 retail bodies become creator presets (face + body), or start fresh? | 12 face presets per base drawn from them |
| U6 | Jiggle on by default, and its strength cap | on (Medium+), the clamp of §9.2 |
| U7 | Townsfolk on the new bases later? | no: they keep the VAT townsfolk |
| U8 | VRAM caps per preset (§2.3) on 4 GB GPUs | Medium 256 MB |
| U9 | When the switch happens (a dated notice in What's new) | with P3 |
| U10 | A friend's Mac / NVIDIA run of `pnpm charbench --serve` for the vendor check | dev PC only |

---

## Appendix: files of this job

| File | What |
|---|---|
| `apps/server/src/cli/charbench.ts` | the driver (`pnpm charbench`): build, preview :5200, headless Chrome per config, results, CPU log, shots, profile |
| `apps/server/src/cli/charbench-bots.ts` | the bench server :7290 and its seeded bots, gear, behaviours, control endpoint :7291 |
| `apps/game/src/debug/charbench.ts` | the page side (`?charbench=1`): prepare, views, knobs, measure, run, census, look check |
| `apps/game/src/world/char-lod.ts` | the P0 switches and distances |
| `apps/game/src/three/outfit-atlas.ts` | atlas packing and UV mapping (pure) |
| `apps/game/src/three/outfit-merge.ts` | the GPU atlas, the material, the merged mesh |
| `apps/game/test/char-lod.test.ts` | tests: atlas packing and UVs, the plan's far/outfit decisions and hysteresis, the actor's merge (parts, rects, hide/restore, Berserk hair, opacity, cull, release), the clip snap |
| `apps/server/test/charbench-bots.test.ts` | tests: the seeded crowd, the behaviour split, the plaza placement, the dressing rules and rates |
| `work/tmp/charbench/p0/` | the results of §1.2 (`<config>.json`, `summary.md`, `cpu.json`, `chrome-*.log`) |

Shared files touched (small, additive): `apps/game/src/three/models.ts` (the outfit merge on `CharacterActor`,
`snapClips`, `ModelLibrary.outfitAtlases` / `decorateMaterial`), `apps/game/src/world/crowd-budget.ts` (the `far` and
`outfit` decisions), `apps/game/test/crowd-budget.test.ts` (the decision literals gained the two fields),
`apps/game/src/params.ts` and `apps/game/src/main.ts` (`?charbench=1`), root `package.json` (`pnpm charbench`).

---

## 15. P1 stage 1: the female pilot (2026-10-06) [confirmed: Blender, converter, bench]

**Built.** The female base from the approved concepts (a1/a2), one degree-3 garment (d1), two hairstyles (c1: high
ponytail, bob), five body morph pairs, rigged to the untouched retail `europewoman_skel` (45 joints) + `chest_L/R`,
`glute_L/R` (children of `Bip01 Spine1` / `Bip01 Pelvis`, appended, weighted ≤ 0.7 of their parent's share, not
simulated). Every retail clip plays unchanged (the clips retarget by joint name; checked in Blender on STAND1, RUN,
ATTACK1_sword_base_01, SIT and in game with the sword stance).

**Pipeline used** (dream-loop pro, 2 build/judge rounds):
1. Higgsfield `multi_image_to_3d` (Meshy) on a1 + a2, `pose_mode: t-pose`, PBR, 60 k tris (30 credits) → the base;
   `image_to_3d` on the d1 woman (crop) → the garment (30 credits). Sources: `work/tmp/pilot/src/*.glb`.
2. Blender (MCP): merge the UV-split soup, cut the generated ponytail off the head (a scalp ellipsoid closes the
   hole), decimate with the head protected (body 11,471 tris, head 3,196; garment cut at the neck and wrists, 13,499),
   **fit-rig**: a copy of the retail skeleton posed onto the mesh (arms −3.2 cm, legs rotated in to the generated
   stance), automatic weights on that copy, then posed back onto the retail rest with Copy Transforms and applied: the
   mesh ends in the retail bind pose with weights for the retail joints (cloak/Bone01/02/HandMid excluded).
3. Body morphs (`body_{breast,buttocks,hips,waist,thigh}_{minus,plus}`): smooth displacement fields authored on the
   base, tuned against b1/b3 (the 100 end ≈ b3); the garment carries the same ten shapes by name, transferred from
   the base's nearest surface (10-nearest inverse-distance), so it follows every slider; the regions it covers are not
   drawn, so the body cannot poke through there at any value.
4. Hair: procedural cards (ponytail 1,880 tris incl. a tie ring, bob 1,126) on a generated strand texture (alpha
   test, two-sided), bound to `Bip01 Head`; in game a Babylon anisotropy (0.75 along the strands) stands in for the
   two-lobe shader of §6.
5. Regions: the base is split by dominant joint into `pilot_body_{head,neck,torso,upperarm,forearm,hand,thigh,calf,foot}`.
   Textures 1024² (albedo JPEG, normal, metal-roughness; hair 512 × 1024 PNG). Blend file: `work/tmp/pilot/female_pilot.blend`.

**Export** (Blender glTF, then the converter step):
```
pnpm tsx packages/convert/src/tools/pilot-char.ts [--in work/tmp/pilot/export/female_pilot_blender.glb]
```
writes `work/out/char/pilot/female_pilot.{glb,json}` and the same under `work/out-opt/`: retail joints reset to the
retail glb's exact rest (Blender's export was within 6e-6) and inverse binds recomputed, emissive dropped, hair MASK,
body metallic 0, opaque textures JPEG, budgets enforced (fails the build above §2.3). The sidecar is the retail slim
sidecar's clip index + animation packs + `pilot` (outfit covers, hairstyles, morph names, triangle counts). No KTX2
yet (P1's texture arrays take the layers). Glb 6.0 MB.

**Budget**: LOD0 base look 13,351 tris, garment look 20,809 (≤ 30 k); body 11,471 ≤ 12 k, head 3,196 ≤ 4 k, outfit
13,499 ≤ 14 k, hair ≤ 1,880 ≤ 4 k; 49 joints; 4 influences.

**In game**: `?newchar=1` (own character, female only) swaps the body for the pilot; `newchar=slim|curvy|average`,
`ncoutfit=base|garment3`, `nchair=ponytail|bob`; weapons and shields still dress on the retail sockets, armour items
are not drawn. Others and the crowd tier are untouched (the own character is never in the crowd). Code:
`apps/game/src/three/pilot-char.ts` (+ `Look.pilot` in `models.ts`, the swap in `world/entities.ts`), test
`apps/game/test/pilot-char.test.ts`. Portraits: `pnpm charbench --configs webgpu-medium --bots 4 --bench-model
CHAR_CH_WOMAN_ADVENTURER --query newchar=1 --pilot-shots <dir> --pilot-alpha 1.5708`.

**Judge** (round 2): Composition 8, Lighting 7, Materials 7, Details 7 (`characters/pilot/stage1.png`). Below the
gate of 8: the white cloth and face read washed out under the plaza noon sun, the hair cards are dark and blocky up
close, the generated face loses detail at 3 k tris.

**Bench** (WebGPU Medium, 100 bots, mid, 1 round, the bench character a woman; machine ≈ 29 % CPU): retail body
20.3 / 32.0 ms p50 / p95, 408 draws; pilot 20.8 / 28.2 ms, 409 draws (an earlier pilot run 19.8 / 29.9): no
regression. Results: `work/tmp/pilot/bench-{retail2,pilot2}/`.

**Stage 2**: the creator UI (body tab), the look blob and its storage (§5.3), jiggle simulation (§9.2), the CPU bake
of the morphs instead of live influences, the region-split body merged into one mesh/material (§2.2), LOD1/LOD2,
the hair shader proper, a second judge pass on lighting/skin (skin shading §7) and the face.

### 15.2 Stage 1b: the base body rebuilt (user rejected stage 1)

Root cause: the body was forced onto the retail rest joints (shoulder pivots 5 cm inside the torso at x = ±0.109,
retail neck/limb lengths) and every retail clip also keys every joint's translation, so the retail proportions were
enforced in every pose; the mesh came from a clothed concept (anatomy guessed under baggy cloth).
Fix: a new anatomy source (`characters/concept/a5-female-anatomy-turnaround.png`, form-fitting base garment, front /
side / back → `multi_image_to_3d`); a skeleton with the retail **names, hierarchy and rest orientations** but the
body's **own joint positions** (shoulders ±0.17, arm/leg/spine/neck lengths: `pilot.boneLengthVsRetail` in the
sidecar); the converter keeps retail orientations exactly and the body's positions; the game drops the clips'
non-root translation tracks on a pilot body (`CharacterActor.restOffsets`). Morphs gained `shoulders` and became a
coherent body type (breast + ribcage girth, hips = pelvis width, full-length thighs). Blend:
`work/tmp/pilot/female_pilot_b.blend`. Garment and hair are paused until the base passes.

### 15.3 Stage 1c: the MPFB body (user rejected 1b: distortion)

Body source: **MPFB2** (MakeHuman for Blender, v2.0.17) instead of image-to-3D: female, age 25, muscle 0.55, weight
0.45, proportions 1.0, height 0.635 (1.71 m), asian 0.7 / caucasian 0.3, cup 0.65; no sculpting. No MPFB asset pack is
installed, so there is no proxy: the body (helpers removed, eyes kept) is decimated 27 k → **11,500 tris** with X symmetry.
Weights: MPFB `game_engine_with_breast` (breast bones → `chest_L/R`, finger pairs merged onto the retail fingers),
max 4 influences. Rest: the MPFB rig is posed onto the retail T rest by limb direction (arms, legs, hands, fingers;
spine and feet keep MPFB's), the mesh and every morph baked in that pose. Skeleton: the retail one (names, hierarchy,
rest orientations exact) at MPFB's joint positions; `Bip01` = the retail root × `rootScale` (own hip / retail hip,
0.957), which the game applies to the clips' root translation (`CharacterActor.rootScale`, sidecar `pilot.rootScale`).
Clips: the retail ones play directly; on a pilot body only rotations and the root translation play
(`three/pilot-clip.ts`, used by the game and checked by the converter over the default + sword packs: no scale, no
non-root translation kept). Morphs (min/max pairs, from MPFB targets/macros): breast (cup), buttocks, hips
(hip-scale-horiz), waist, thigh, shoulders, weight, muscle. Blend: `work/tmp/pilot/female_pilot_mpfb.blend`; export
`work/tmp/pilot/export/female_pilot_mpfb_blender.glb` → `pilot-char.ts --in …`. Debug: `__sroPilot.pose(null | clip, frac)`;
charbench `--pilot-shots` adds the bind, live and pose shots. Sheet: `characters/pilot/mpfb-test.png`.
Known: kneel/crouch sink 4–7 cm (own leg proportions vs retail root), LBS creases at groin and twisting chest, no twist
bones at the wrists, slim reads close to average.

### 15.4 Stage 1d: clothed (a5 base outfit), skin, face, hair

Outfit `pilot_outfit_a5` (7,085 tris, 4 materials `pilot_outfit_garment_{cloth,trim,wrap,shoe}`, one tiled 512² fabric
albedo + normal): the fitted top, leggings, shoes and wraps are derived from the body faces (cross-sections pushed to
their convex hull, an under-bust bridge, light smoothing, a normal offset of 4–10 mm, armhole/neckline trim strips);
the side-slit tunic skirt with its sash band and the stand collar are parametric rings sized from the body's hull.
Every one of the 16 body morphs is rebuilt by running the same construction on that morph's body, so the outfit follows
all 8 sliders; weights are the body's (skirt blended toward the pelvis). The body is split into `pilot_body_skin` (6,616)
and `pilot_body_under` (4,884, hidden by `a5`: `pilot.outfits.a5.covers = ['under']`). `?newchar=1` is clothed by
default; `ncoutfit=base` shows the unclothed body. Skin: a 1024² body albedo baked from a tone sampled off a5; the head
has its own 1024² texture (smart-UV islands) baked from the a5 front face projected onto the MPFB head (eyes, lips),
with a painted hair cap; the stage-1 ponytail cards refitted to the MPFB head. No MPFB asset pack is used.
Deep poses: `CharacterActor.enableGroundClamp()` lifts the root after the clips so no knee/ankle/toe joint goes below
its clearance (kneel and sword crouch). Scripts: `work/tmp/pilot/mpfb/{garment,split,snap}.py`; sheet
`characters/pilot/mpfb-clothed.png`.

## 16. Licensed characters: River Spirit Waterbender (2026-10-07, first milestone)

**Licence (hard rule).** The purchased pack (IdaFaber, Fab Standard License) and everything made from it are never in
git and never in the public release. Working files live only under `work/` (git-ignored): `work/licensed/waterbender/`
(Blender exports, shots) and `work/out(-opt)/char/licensed/waterbender/` (the game's glb + sidecar). The tools are in git
and read the pack from a path you give them (`--src` or `SRO_WATERBENDER_SRC`). A server without the files (any clone
from GitHub) plays the existing characters: the game fetches the sidecar first (`three/licensed-char.ts`
`licensedAvailable`) and falls back silently.

**Build.**
```
blender -b --factory-startup --python packages/convert/src/tools/licensed/waterbender-export.py -- --src "<pack>"
pnpm tsx packages/convert/src/tools/licensed-char.ts --src "<pack>"
```
Seven variants (`waterbender_f_01..04`, `m_01..03`; each outfit FBX carries its own hairstyle and only the body pieces
its clothes leave visible). The artist's skeleton (Epic UE5 + hair/cloth bones, 230 / 187 joints) and weights are kept
untouched; only the FBX object transform is applied. Full detail for now (83–135 k tris), textures 2048 (base, normal;
UE DirectX normals flipped to OpenGL) and 1024 (ORM / roughness), JPEG/PNG, no KTX2 yet.

**Clips** (`three/retarget.ts`, played by `three/retarget-clips.ts`): the retail Chinese man/woman clips are rebuilt for
the Epic skeleton by role (pelvis, spine_02/04, neck_01/02, head, clavicles, arms, hands, thumb/index/middle — ring and
pinky follow the biped's Finger2 —, thighs, calves, feet, balls). Rotations only: each mapped joint takes its retail
joint's world rotation change from the retail rest, on top of the body's rest turned onto the retail T-pose (arms,
legs, hands incl. palm twist, fingers; spine/neck/head/clavicles keep the body's own posture); the hip path is the retail
pelvis path × hip-height ratio. No per-joint translation, no scale. Weapons/shields hang on stand-ins for the retail
socket joints (`spec.sockets`, under the matching Epic joint). Ground clamp on pelvis/calf/foot/ball.

**In game**: every player (§16.8; was `?newchar=1`, own character only); `?newchar=0` = the retail models, `ncoutfit=01..04` (girl) / `01..03` (boy) on the own character;
the pilot (§15) stays on `newchar=average|slim|curvy`. Look check: `pnpm charbench --configs webgpu-medium --bots 0
--query newchar=1 --bench-model CHAR_CH_WOMAN_ADVENTURER --pilot-alpha 1.5708 --licensed-shots <dir>`
(`__sroLicensed.pose(clip, frac)`). Tests: `apps/game/test/retarget.test.ts`. Sheet: `characters/waterbender/first-look.png`.
Not yet: KTX2, skin/eye/hair shaders, face blendshapes, separate hair choice. (LODs, the crowd, everyone on the licensed bodies: §16.8.)

### 16.1 Materials and lighting pass (2026-10-07)

**Maps, checked per channel** (`licensed-char.ts` `materialMaps`): normal-map convention measured, not assumed (curl test
dR/drow vs dG/dcol, plus the slope test against Height/Depth where they exist): clothes, lingerie, head and the male body
are DirectX (green flipped), the female body (`T_BODY_F_UPD`), hair and eyes OpenGL. MaskMap = HDRP (R metal, G AO,
B detail, A smoothness; A = 1 − Roughness, r −0.99): skin ORM = (G, 1 − A, 0); the clothes' ORM is already glTF's.
Base colour / normal 2048 (head, body, clothes, eyes, hair), ORM 2048 skin/clothes, 1024 eyes/hair/lashes; JPEG q92
4:4:4; eye lid occlusion (T_EYES_AO) in albedo × 0.5–1 and as AO; hair root-to-tip darkening (T_HAIR_WAVY_Root);
skin albedo saturation 1.12 × gain 0.95 (the warmth UE's SSS adds).
**Game** (`three/licensed-materials.ts`): skin F0 0.028 + a faint warm sheen (translucency was tried: without a
thickness map the sun through the head turned the face orange); eyes a clear-coat cornea (IOR 1.376, rough 0.03); lashes
alpha-test + blend; hair an alpha-tested core (0.5) + a blended soft pass, anisotropic highlight along V; anisotropic
filtering 8. **Lighting**: the own character's key light (`world/features/self-key.ts`: 0.6 × the celestial light,
from 35° above / 25° right of the camera, PBR only; `__sroPerf.charLook` A/B); the day grade deeper and richer
(`grade.ts` day: gamma 0.96, saturation 1.10, contrast 1.06; dusk/night untouched). Tried and not taken: Filmic/ACES
(darkened dusk and night), the sky cube read linear (glossy, grey night pavement). Perf (WebGPU Medium, 40 bots, A/B):
plaza p50 9.8 → 10.0 ms, fields 5.7 → 5.9 ms, GPU unchanged. Sheet: `characters/waterbender/materials.png`.

### 16.2 Hair, cloth and body springs (2026-10-07)

**Bones** (every variant carries all of them; a chain no visible skin weights is skipped, `weightedJoints`): hair
`hair_back_01..07_{l,mid,r}`, `hair_front_01..06_{l,r}`, `dk_bun_*` (female), `riverspirit_ponytail_01..07`,
`riverspirit_hair_small_tail_*` (male); robe `riverspirit_skirt_{back,side}_01..06_{l,r}`, `front_cloth_01..06`,
`layering_01..03`, `tails_01..07_{l,r}`; sash `riverspirit_bow_0N_*` (under the animated `bow_main_{l,r}`),
`bow_flowers_*`, `rope_01..03`; jiggle `breast_{l,r}` (female; no glute bones in the pack, none added: that needs a
re-weight). No sleeve bones. f_01: 23 cloth/hair chains + 2 jiggle, 144 particles.
**Solver** (`three/spring-bones.ts`, engine-free): verlet, fixed 1/60 s (≤ 4 steps a frame), targets interpolated per
step, damping relative to the chain root + world drag (the trail while running), stiffness towards the animated pose,
tether (last, exact: never drifts), follow-the-leader lengths, capsule push-out (pelvis, thighs, calves, chest, neck,
head; shrunk per chain where the bind pose sits inside), drawn as pose + offset blended between the last two steps
(CLOTH.md §6.4), reset on a > 0.25 s frame or a > 1.5 m jump. **Glue** (`three/char-physics.ts`): after the clips and
the ground clamp, the chain's pose from its anchor's world matrix and rest locals, then each bone turned (rotations
only) so its child lands on its particle; allocation-free. Jiggle: `CharPhysics.setBody(size 0..2, armour 0..1)`
(creator slider → amplitude; heavy armour ×3 stiffness, ×0.4 swing).
**Budget**: nearest characters within 20 m of the camera (3 m hysteresis): Low/Classic 0, Medium 8, High/Ultra 12
(`physicsMaxFor`); Options → Graphics → "Hair & cloth physics", "Body physics" (on). Debug: `__sroLicensed.runStop(at)`,
`clones(n)`, `physicsConfig({...})`. Perf (WebGPU Medium, 20 Waterbenders at full detail, frame p50 interleaved):
off 20.8 / 20.8 ms, on (8) 21.8 / 21.3 ms, on (12) 22.1 ms; GPU unchanged (3.2 ms). Tests: `test/char-physics.test.ts`.
Sheet: `characters/waterbender/physics.png`.

### 16.3 Face look: materials, lighting, camera (2026-10-07)

**Geometry untouched** (checked: no morphs, face bones at bind, source FBX head = glb head in Blender pixel for pixel,
game skin = glb bind ±0 mm). **The cheek/forehead blocks** were the sun's shadow map (1024², 2 cascades): the head's
self-shadow (acne) and the hair cards' quads. Hair, lashes, eyes and the head (`MAT_HEAD`) now cast no shadow
(`metadata.sroNoCast` on mesh and material, honoured by world-render `selectCasters` for character roots and parts);
body and clothes still cast. **Makeup**: `FACE_DEFAULT` girl `16_04` (liner, painted lower lashes, light brows), boy
`04` (dark brows, reddish lower lids), converter `--face-f/--face-m`; `--faces-f/--faces-m` write other variants to
`faces/<g>_<v>.jpg`, picked in game by `?ncface=` or `__sroLicensed.face(v)` (`licensedFaceUrl`, the creator's hook).
**Skin**: grade sat 1.0, gain 0.97, warm × (1, 0.94, 0.86); sheen 0.10 (was 0.18, pinker). **Light**: self key 0.42 of
the sun (was 0.6), specular 0.15 (was 0.35). **Hair** F0 × 0.45 (black, not a grey glaze); **lashes** albedo × 0.35.
Eyes stay `T_EYES_BaseColor_37` (01–36 use another UV layout). Judging camera: fov 0.34 (≈ 70 mm), eye level, 3.2 m
to spine_05, open field at noon (the plaza bench spot sits in a building's shadow edge). Sheet: `face-fix2.png`.

### 16.4 Face look: root-cause ladder (2026-10-07)

**Ladder** (sheet `characters/waterbender/face-fix3.png`; lab: charbench `--steps`, `work/tmp/ff3/`). 1) The game's own glb
textures rendered in Blender (EEVEE, studio HDRI, Standard view) look like the artist's renders: the textures are read
right; the game path is at fault. 2) Texture path ruled out: JPEG q92 4:4:4 vs the source resized to 2048 is 47 dB
(albedo) / 43 dB (normal) on the face; the albedo is an sRGB buffer (decoded once); normal off changes little.
3) Direct light alone shows the noon sun grazing the face (hard terminator across the cheeks); environment alone shows a
flat, lavender face: the world's ambient is L1 sky SH whose ground half is the SKY's irradiance × 0.25 — the sun's light
off the ground (≈ 5× the sky's at noon) is missing. 4) Exposure: the world maps a lit white horizontal surface to 2.15
(calibrated on retail albedos); the pack's skin (≈ 0.43 linear) sat in the tone map's shoulder: 12–15 % of the face's
skin pixels ≥ 245 against 0 % in the artist's renders (p99 ≈ 205).
**Fix** (`world/features/self-env.ts`, `__sroPerf.charEnv`): the own licensed body's skin gets its own 32² linear cube
with L2 SH: the world's sky above the horizon (its SH as radiance), below a Lambertian ground (albedo 0.25) lit by the
celestial light and the sky; refreshed every second in slices. All its materials take a light trim of 0.6 (direct and
environment): skin p99 243–249, 0.8–1.6 % ≥ 245. Perf (WebGPU Medium, 20 Waterbenders, interleaved ×3): frame p50
off 24.4/24.5/24.5, on 24.3/24.6/24.1 ms; GPU 3.81 both. Lab hooks: `__sroSelfEnv` (roles, trim), `__sroSelfKey`.
**Not taken**: Babylon's prepass SSS (on Medium it smeared albedo — lips, brows — and needs a scene-wide prepass);
4K head textures (no evidence: the close-up already samples ≈ 1:1); moving the self key (45° made little difference).
**Left**: the noon sun is top-down and the artist lights a frontal soft key in a dark studio; no real diffusion (the
terminator stays hard); the eyes read larger/bluer than in the renders.

### 16.5 Eyes and the face light (2026-10-07)
**Blue eyeballs, root cause**: the eye meshes are the centred layout of `T_EYES_BaseColor_01–36` (measured: cornea
front at UV 0.5, 0.5; iris edge ≈ 30° → r 0.12 = the maps' iris r 0.11); `_37` is no albedo (upper half black, grey
sclera), and the eyes alone kept the world's sky SH as their ambient (no sun-lit ground bounce), so the sclera showed
a blue sky. **Fix**: iris `EYE_DEFAULT` girl 36, boy 31 (pupil baked, `licensed-char.ts`); the eyes take the self-env
cube (`SELF_ENV.roles` + 'eye'); sclera tint (1, 0.97, 0.93). Sheet `characters/waterbender/eyes-fix.png`.
**Face light** (`world/features/self-key.ts`, `__sroPerf.faceLight`, live knobs `__sroSelfKey`): the key moved to ≈ 20°
above the line of sight and gets a floor = 2 × the sky's ambient (π·share·a, neutral warm white: scales with the
world, no glow at night); a fill from the other side, slightly below, 0.5 × the key, no specular, head + eyes only;
both on the own body and the 6 nearest licensed bodies within 14 m. Skin wrap diffuse 0.3 (`SkinWrapPlugin`, a regex
on `result.NdotL` in the PBR light setup, GLSL and WGSL). Perf: GPU p50 equal on/off (webgpu-medium, 20 clones).
Sheet `characters/waterbender/face-light.png`.

### 16.6 Face light: absolute minimum, girl's iris (2026-10-07)
The sky-relative floor collapsed at dusk and night (cheek luma 0.10). Now the key is ≥ `FACE_MIN.exposure` / the post's
exposure (≈ 11 noon, ≈ 70 dusk/night), so the face's display brightness has a floor; when the minimum carries the key
its colour leans half-way to the celestial light's (the moon's blue at night; the sky's SH reads teal); fill 0.7 of the
key. Cheek luma (70 mm, mean of both cheeks), min 22 / fill 0.7: girl noon 0.62, dusk 0.37, night 0.40; boy dusk 0.41,
night 0.44 (noon at fill 0.5: 0.63). Sweep min 8 / 16 / 30 → night 0.26 / 0.33 / 0.41. Girl's iris `T_EYES_BaseColor_01`
(light warm brown) with the pack's `T_EYES_PupilSample` drawn over (`Slot.overlay`). Sheet `face-light2.png`.

### 16.7 Skin: under-eye, face shadows, skin term (2026-10-07)
**Root causes** (lab `work/tmp/skin/`, under-eye / cheek luma at 70 mm, girl noon; A/B per term). 1) **The face key and
fill lit the back of the head**: the world scene is right-handed, `Vector3.Forward()` is the camera's backward axis there
(measured key · view = −0.875). Key and fill were a rim light: the face front had only the environment, and the rims drew
the hard lit stripes down the nose and cheek edges (dusk: half the face black). Fix: `cameraAxes` (`Vector3.Forward(rh)`).
2) **The under-eye darkness is painted**: with a flat albedo the lit under-eye / cheek is 0.88 (sun overhead) / 0.99 (dusk);
with the map 0.61. The makeup layer (16_04 / bare 00, boy 04 / 00) paints a grey-mauve band under the lower lid at
0.69 of the cheek. Converter `liftUnderEye` (`UNDER_EYE` zones of the shared head UVs, feathered, per-column cheek level,
k 0.75, max ×1.45; lid line, lashes, freckles keep their contrast): albedo ratio girl 0.84 → 0.93, boy 0.81 → 0.85;
`--under-eye-k 0` for the A/B. Ruled out (no change on/off): the pack's AO (MaskMap G is white on the face, a scalp
mask; Babylon applies it to the environment only), specular/horizon occlusion, the normal map, shadows (head, hair,
lashes, eyes cast none), the eye meshes; hair off +0.01. 3) **Orange noon skin**: the §16.3 warm albedo grade
(1, 0.94, 0.86) compensated the env-only face; with a real key the cheek read g/r 0.68, b/r 0.55 (albedo 0.74 / 0.69,
render 0.83 / 0.80): grade back to neutral (`--skin-warm`). The world's day grade (sat 1.10, contrast 1.06) still
leaves noon skin at g/r 0.67 (world-render, not changed here).
**Skin term**: `SkinWrapPlugin` now wraps only the diffuse (`computeDiffuseLighting`), per channel `SKIN_SCATTER`
(0.42, 0.20, 0.13): a warm soft terminator, the pre-integrated skin look; the §16.5 version also wrapped the GGX
specular's N·L. **Face light retuned** for a key that hits the face: share 0.1, floor 0.5, min 5 (display-referred,
less the celestial light already on a face turned to the camera, `faceKeyNeed`), fill 0.35. Cheek luma (girl) noon
0.69, dusk 0.70, night 0.66; under-eye / cheek 0.91–0.95 (was 0.61). Sheet `characters/waterbender/skin.png`.

### 16.8 Everyone on the licensed bodies; looks, LODs, crowd; weapon grip (2026-10-07)
**Option A (user-approved): the Waterbender is the standard body of every player.** No URL flag any more: every client
draws every player (own, others, character select) on the body of its look; `?newchar=0` is the debug escape to the
retail models (and `newchar=average|slim|curvy` the §15 pilot). A server without the pack (a GitHub clone) answers 404
for the sidecar: `licensedAvailable` (once per file) says no and everything draws the retail models as before.
**The look** (`packages/shared/src/look.ts`, `CharLook v1`): body (= the model's gender), outfit variant, hair (an
outfit's hairstyle for now), makeup id, iris id, hair colour 0–31, skin tone 0–23 + shift ±50, markings ≤ 4 and
accessories ≤ 6 (ids), height 0–4, build (weight, muscle, chest, buttocks, hips, waist, thigh, shoulders 0–100, the §5.2
defaults). `parseLook` clamps numbers and refuses wrong versions, bodies and ids. **Server**: migration 23
(`characters.look`, JSON; every existing character gets its body's default: the outfit from a hash of the id (top 16 bits of
`id × 2654435761 mod 2³²`, mod n) so alternating genders still spread over every outfit, the retail Volume as Weight); `charCreate.look?` (the creator,
later; its body must be the model's), `CharacterSummary.look`, `EntityState.look`, `appearance.look?` (additive; a
client drops a look it cannot parse, not the message). Drawn today: body + outfit (+ its hair) and height; makeup, iris,
colours, markings and build are stored and sent for the creator / outfits-by-gear jobs (per-instance parameters, §2.4).
**Loading**: a player whose body is still loading shows a light translucent stand-in (one shared capsule, an instance
each), never the retail model first.
**LODs** (`waterbender-export.py`, Blender Decimate collapse; the bought LOD0 is never changed): every part also as
`<part>__LOD1` / `__LOD2`, then joined into one object per LOD (`SK_WATERBENDER__LOD1/2`: one mesh per material in the
game, ≈ 6 draws instead of ≈ 20), same armature and materials; face and hands collapse last (a vertex group
1 − 0.9 × the head/neck/hand/finger weights); teeth, caruncles, lashes, helper shapes out of both, eyes, earrings and
the rope out of LOD2. Triangles LOD0 / LOD1 / LOD2: f_01 93.7 k / 23.3 k / 5.7 k, f_02 135 k / 39.9 k / 10.7 k,
f_03 114 k / 31.3 k / 8.1 k, f_04 94 k / 27.7 k / 7.4 k, m_01 104 k / 29.1 k / 7.6 k, m_02 83 k / 20.9 k / 5.1 k,
m_03 98 k / 26.9 k / 6.9 k (sidecar `licensed.lods`). Textures: the lower LODs sample the same maps through their GPU
mip chain (1024 / 512 levels at distance, no second copy); the crowd's atlas slot is 512². **Selection**
(`char-lod.ts licensedLodFor`, decided in the crowd plan): LOD0 for the own character, target, party and anything
within 8 m; LOD1 beyond (the rest of the close set too), LOD2 beyond 30 m (2 m hysteresis), and the crowd tier
(§3.5) draws its members from their LOD2 parts (one thin-instanced batch per outfit + weapon, the VAT baked from the
retargeted clips). Hair and cloth springs (8 nearest within 20 m) and the face light (6 within 14 m) stay as they were.
Weapons on the stand-in sockets bind to the stand-in's joint in the crowd (at the socket's rest place).
**Shared clips**: the retargeted clips are built once per body file and source clip (`retargetGroup`'s cache) and
shared by every actor of that file (100 players redid the FK + IK 100 times and the crowd VAT baked each actor's copy
separately; the first 100-player run never finished loading).
**Perf** (`pnpm charbench`, 100 bots, 2 interleaved rounds × 300 uncapped frames, 1920 × 1080; retail = `--query
newchar=0`, same build, back to back, machine CPU 22–26 %; `work/tmp/wb/final-*`), p50 / p95 ms:

| | close retail → new | mid retail → new | far retail → new |
|---|---|---|---|
| WebGPU Medium | 23.0 / 31.7 → 27.5 / 38.9 | 20.7 / 29.2 → 24.5 / 37.3 | 15.9 / 24.1 → 19.7 / 32.7 |
| WebGL2 Medium | 17.1 / 24.0 → 22.1 / 30.9 | 16.1 / 24.1 → 19.4 / 28.3 | 12.9 / 20.8 → 16.3 / 25.5 |

Floor (no crowd) 11–14 ms; GPU 3–4 ms: CPU-bound. The new bodies cost **+3.3 to +5.0 ms p50** over the retail ones
(animations of 187/230-joint skeletons, the LOD0/LOD1 parts' draws, the springs); neither meets the 16.7 ms line on
this PC yet. Next levers: the close set's LOD0 parts merged per material at load, the hair kept in the crowd atlas
(its UVs leave the 0–1 square: a second draw per batch), the crowd batch key without the weapon's pose, KTX2.
**Fixed on the way**: the crowd page copy of a new outfit slot could land before its maps were on the GPU (whole
outfits invisible in the crowd on a busy load): each slot is copied again 3 and 60 frames later. The soft hair pass
cloned the hair material after the world's surface plugin was on it (threw for every boy loaded in the world):
`cloneUndecorated`, then decorated again.
**Weapon grip** (user report: the glaive held upright at its butt, the left hand floating by the face; trailing on the
ground). Root causes: (1) the retail clips slide the weapon socket `Bip01 R HandMid` along the shaft (spear stand
in town −0.19 m, other stands up to −0.99 m); the stand-in was fixed under `hand_r`. Now every `HandMid` stand-in
follows its retail joint's own keys (`socketFrame` / `socketLocal`, a fixed turn × the retail local under the anchor).
(2) Rotations alone put each hand where the retail hand is *turned*, not where it *is*: the Waterbender's arms are
other lengths, so the off hand missed the shaft. Two-handed packs now IK the off hand onto the retail hand's offset
from the weapon socket (`offHandIk`, two-bone, elbow kept in its plane, hand rotation kept; spear + glaive: the left
hand to `R HandMid`; bow: the right hand to the bow hand), baked into the retargeted clips. Swords, blades and shields
are one-handed and unchanged. Sheet `characters/waterbender/weapons-grip.png` (retail left, new right; idle and attack,
girl and boy, sword + shield, blade, spear, glaive, bow); run and sit checked too. Tests: `retarget.test.ts`.

### 16.9 Outfits from gear (2026-10-07)
**The worn armour decides the look** (user-approved; stats, levels, sources are the retail items' unchanged; the client
reads the `equip` codes it already gets). **Pieces** (`three/licensed-outfit.ts`, data): `ITEM_CH_<M|W>_<CLOTHES|LIGHT|
HEAVY>_<dd>_<HA|SA|BA|LA|AA|FA>_<A|B|C>[_RARE]` → slot, class (garment / protector / armour), degree, grade, seal. Slot ×
class → pieces (`SLOT_PIECES`): chest TOP (+ LAYERING, FRONT_CLOTH protector; + BELT, ROPE, FLOWERS armour; the girl's
BELT_cut without a skirt), legs PANTS (+ CHAPS; + SKIRT), hands GLOVES (protector / armour; a garment's draw nothing),
feet SHOES, shoulders SLEEVES (+ TAILS armour). The earring: see below; head, necklace, rings draw nothing yet. Mixed
classes work per slot; an empty chest / legs shows the pack's lingerie. **Body slices**: the export ray-casts every
BODY_PART vertex against every piece (out along the normal ≤ 15 cm, or ≤ 6 mm away) and stores the covering masks;
a slice is hidden when the worn pieces cover ≥ 94.5 % (the legs under the loose pants ≥ 70 %), never the neck or the
hands. **Export** (`waterbender-export.py`, default on, `--no-wardrobe` for the old files): every variant also imports
the separated pieces it lacks (lingerie, the other belt, all body slices), bound to its armature; pieces and slices keep
their own objects at every LOD (only head / eyes / hair / earrings are joined per LOD), `<name>.pieces.json` (coverage,
the 256² clothes-UV owner map). **Converter** (`licensed-char.ts` + `licensed/cloth-dye.ts`): `licensed.wardrobe` in
the sidecar; `clothes_shade.jpg` (2048: BaseColor_05's brightness over its region's mean + the leather weight),
`clothes_dye.png` (1024 RGB: main / second / trim weights from the MatID map; light = the rest), `clothes_lo_<g>.png`
(256: shade, region, owner piece); MatID colours → 5 regions measured against BaseColor_01 / metal / owners; lingerie
a flat linen. `--out <dir>` for a trial build. **Colour** (`PALETTES`, data): per class × D1 undyed / D2 dyed / D3 rich
+ trim / D4 deep + gold or silver trim; grade B/C ×1.08 / ×1.16 trim richness. **Drawing** (`three/licensed-cloth.ts`):
LOD0/LOD1 one material per palette (class, degree, grade, seal), shared by every body, `ClothDyePlugin` (GLSL + WGSL):
regions recoloured from the dye map on the shade, D3+ silk sheen on the trim (view-dependent, lit), D4 a fine twill
shifting with the view (fades where it would alias), seals: Star a violet nebula drifting with the view + rare
twinkling specks, Moon a pearly iridescent thread on the light cloth and trim, Sun gold trim + a gold embroidery thread
with a faint glow (emissive × the weapons' exposure scale; weaker than RARITY_LOOKS). LOD2 and the crowd: one
material per outfit whose albedo is a 256² CPU bake (`bakeOutfit`, counts as 2048² in the atlases: `atlasSizeOf`);
the palette materials say `sroNoAtlas` (the outfit merge keeps them apart). Reference counted; a re-dress releases.
Visibility via `isVisible` (LOD switch, merges and crowd follow it). **API** (the creator's preview):
`actor.setLicensedOutfit(outfitFromGear(equip, 'f'|'m'))`; `dress()` does it for every licensed body;
`__sroLicensed.gear({chest: '…'})` the look check. A body without `licensed.wardrobe` (old build, no pack) keeps its glb.
Tests `apps/game/test/licensed-outfit.test.ts`. Sheet `characters/waterbender/outfits.png`.

**Seals, earrings, wear (2026-10-08).** The seal looks above were too faint to see; now animated in the cloth itself
(`ClothDyePlugin`, compiled only into outfits with a sealed piece: `SROSEAL`), by a per-scene clock
(`licensed-cloth-fx.ts`; the uniforms go through `hardBindForSubMesh`, which needs `registerForExtraEvents`):
**Star** the dyed cloth (MAIN + SECOND) a deep violet nebula drifting slowly, twinkling star points, faint constellation
lines between a coarser grid's nodes; **Moon** cooled to moonstone, a pearl sheen turning with the view, a slow silver
filigree with a travelling shimmer; **Sun** warm cloth, gold trim, gold veins that glow and breathe like embers, a heat
shimmer running along the trim. Glow × the weapons' exposure scale (day and dusk read; small points / thin lines, no
wash); patterns fade where a cell is under a pixel or two. **Hem particles** (`ClothFx`, one quad batch): Star
sparkles, Moon mist, Sun embers off a ring above the feet and the cuffs, your own + the nearest (MOTE_CAPS, 30 m,
LOD0/1). **Low / Classic**: the clock stops; constellation lines, the filigree shimmer, the heat bands and the particles
off. **LOD2 / crowd**: a static seal tint in the colour bake (`SEAL_FAR_TINT`, `farPaletteLinear`). **Earring** (girl;
the boy's pack has no earring mesh: nothing shown): `ITEM_CH_EARRING_<dd>_<A|B|C>[_RARE]` → `Outfit.earring` (the
chest's class palette at its degree); the EARRINGS part shows while one is worn (`licensed-look.ts` adds it to the look's
parts, attached from the parts glb when missing), its own material (`earringStrip`); a seal adds a tiny sparkle.
Helmets / necklaces: no pack meshes. **Wear** (`world/features/cloth-wear.ts`): dirt and blood 0..3 per character from
combat (hits taken, heavy ones bleed double, kills; fighting), running in the field (×3 in rain / storm); fading slowly
in the field, fast in town, cleared by an accepted repair; applied to bodies within 40 m, off on Low / Classic; the
level is part of the near material's key (`SROWEAR`: one shared material per outfit × level). `clothes_wear.jpg`
(converter `clothWearMap`: the pack's Clothes Dirt / Blood masks; R dirt, G grime, B blood spatter) revealed by a
threshold per level; the cloth only, never the face. **Cost** (20 bots + you, WebGPU Medium, plain D4 armour vs a
Star / Moon / Sun mix, 3 interleaved rounds): GPU p50 2.89 → 2.91 ms (mid view), the close view within noise; the
particles 0.03 ms CPU. Debug: `__sroLicensed.wear(d, b)`, `__sroLicensed.gearAll(equip, n)`,
`__sroClothFx.stats() / particles(on) / seals(on) / freeze(s)`. Tests `apps/game/test/licensed-seal-cloth.test.ts`.
Sheet `characters/waterbender/seal-cloth.png`.

### 16.10 The character creator (2026-10-07)
(§16.9 is outfits from gear.) **Files** (`work/` only): `waterbender-creator-export.py` (Blender) binds the pack's
lingerie body (`waterbender_<g>_base.glb`, no hair) and the separated pieces (`waterbender_<g>_parts.glb`: HAIR_01,
its bangs, HAIR_02, HAIR_03 with `__LOD1/2`; girl EARRINGS, HAIR_FLOWER, NAILS) to the outfit 01 armature by
vertex-group name (rest poses checked: 0.000 cm on every weighted bone; joint list = the outfits'). `licensed-creator.ts`
assigns their maps and writes `look/`: every makeup (45 girl / 17 boy; 2048 for the own character, 1024 for others and
browsing, 96-px thumbs), every iris (36, pupil + lid shadow as §16.5), the white hair for the recolour, the body albedo
and the paint mask (cut below 0.35), `look/index.json`. **Look** (`look.ts`, additive): catalogue-checked makeups,
irises, hair ids = style + bangs (`'01'..'04'` are the outfits' own), 31 hair colours, 23 natural skin tones (linear
multipliers, warm, ≤ 1.03) + shift ±8 %, one body paint of 8 colours, accessories per body; default looks carry their
outfit's accessories. **Drawing** (`three/licensed-look.ts`, every player, `Look.charLook`): per-look material copies
shared by key (LOD2 keeps the file's: the crowd atlas), parts bound to the body's skeleton by index, unwanted parts
`isVisible = false`, the springs rebuilt when the hair changes, girth-only bone scales (≤ ±7 %, shoulders ±5 %,
chest ±12 %; hands, feet, head undone), relative to the body's default build. The joints are Unreal's (local X runs
along the bone), so a girth is Y/Z only, shoulder width the clavicles' X, hip width the pelvis's Z: nothing along a
vertical bone is scaled and the build never changes the height (< 1 mm at bind); height is only the root scale. Not in the crowd tier (far bodies keep
the file's materials). **Server**: migration 24 `characters.look_custom` (0 for every existing character; the girls'
looks get their outfit accessories), `CharacterSummary.customise`, `charLook {id, look?}` (lobby, owner, once, body
checked, 3 per burst) → `charLookSet`. **Client**: `screens/creator.ts` (state + messages: `creator-model.ts`), from
character select's Create when the files are served (else the classic screen) and as the one-time offer on Start
(Edit / Keep). Studio light, portrait camera (face tabs zoom to the head, wheel, drag); the full-body framing is fixed (on the tallest
height), so the height slider reads on screen. Every control redraws while dragging (next frame; makeup maps may take
a moment to load); the tab column is one width (its longest label), labels stay inside their buttons at 1024×600 to
1920×1080. Tests: `apps/server/test/
creator.test.ts`, `apps/game/test/creator.test.ts`. Sheet `characters/waterbender/creator.png`.
