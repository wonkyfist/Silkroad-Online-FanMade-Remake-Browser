# Perf audit: CPU or GPU, and the crowd (2026-10-06)

The user: "I just want to make sure whether it's a CPU issue or GPU, and that the game is running very smooth
regardless of crowds." Target: 60 fps (p95 ≤ 16.7 ms) on WebGPU Medium and High, also with 100 players.

**Answer: it is the CPU, every scene, every preset.** The GPU (RX 9060 XT, 1080p) needs 1.7–4.9 ms a frame; the
main thread needs 5–24 ms. Without a crowd the game already runs at 2× the 60 fps budget (p95 6–12 ms). With 100
players it does not (p95 23–39 ms): the main thread spends it on ≈ 400–520 draw submissions (Babylon's per-draw CPU),
active-mesh evaluation, and game logic for 140 actors (hit effects, animation start/stop, labels).

## Method

`pnpm charbench --scenes plaza,fields,storm,crowd [--ab <switch>|all] [--profile scenes]` (new in this audit;
apps/server/src/cli/charbench.ts + apps/game/src/debug/charbench.ts `setScene`). Headless Chrome 154 on the real GPU
(WebGPU adapter `amd / rdna-4`, WebGL2 ANGLE D3D11), 1920 × 1080, DPR 1, uncapped frames (throughput, not vsync),
noon, the bench camera's `mid` orbit (16 m). Scenes: **plaza** = Jangan plaza, 20 town NPCs, no bots; **fields** =
GM place `grassland` (dense grass, ≈ 80 monsters around); **storm** = the plaza in a GM storm held with no transition
(rain + its own lightning); **crowd** = the plaza with 100 bots (30 walking, 30 fighting 20 Mangnyang, 40 standing).
CPU = engine begin → end of frame; GPU = timestamp queries. Medians of 2–3 runs × 300 frames. Machine CPU (whole PC)
and min free RAM are logged per scene; the PC was shared (other helpers, Discord, Dropbox).
Raw runs: the session scratchpad `out/{base1,storm2,storm3,crowd1,ab3,ab5}` (JSON, `.cpuprofile`, `top.txt`).

## Results (before the fixes)

| Scene | Config | p50 / p95 ms | CPU p50 | GPU p50 | draws | active meshes | machine CPU % / min free MB | Verdict |
|---|---|---|---|---|---|---|---|---|
| plaza | WebGPU Medium | 6.8 / 8.1 | 6.5 | 2.4 | 268 | 226 | 21 / 1795 | CPU-bound, 2× headroom |
| plaza | WebGPU High | 8.0 / 11.4 | 7.8 | 3.3 | 354 | 254 | 20 / 2150 | CPU-bound, OK |
| plaza | WebGL2 Medium | 5.5 / 6.4 | 5.2 | 2.3 | 269 | 228 | 20 / 3014 | CPU-bound, OK |
| fields | WebGPU Medium | 6.4 / 8.0 | 5.9 | 1.9 | 272 | 272 | 20 / 1464 | CPU-bound, OK |
| fields | WebGPU High | 8.5 / 10.5 | 8.0 | 4.1 | 338 | 298 | 22 / 2082 | CPU-bound, OK |
| fields | WebGL2 Medium | 5.3 / 6.3 | 4.9 | 1.7 | 270 | 276 | 23 / 2816 | CPU-bound, OK |
| storm | WebGPU Medium | 7.3 / 9.3 | 7.1 | 2.7 | 270 | 225 | 22 / 1763 | CPU-bound, OK (+0.5 ms vs plaza) |
| storm | WebGPU High | 8.0 / 12.2 | 7.9 | 3.5 | 354 | 253 | 14 / 1771 | CPU-bound, OK |
| storm | WebGL2 Medium | 5.5 / 6.4 | 5.2 | 2.4 | 274 | 229 | 20 / 2503 | CPU-bound, OK |
| **crowd** | WebGPU Medium | **19.0 / 26.7** | 16.9 | 2.7 | 401 | 377 | 24 / 1796 | **CPU-bound, over budget** |
| **crowd** | WebGPU High | **26.1 / 38.9** | 23.7 | 4.9 | 518 | 468 | 26 / 280 | **CPU-bound, over budget** |
| **crowd** | WebGL2 Medium | **15.4 / 22.9** | 13.6 | 2.4 | 404 | 377 | 25 / 1764 | **CPU-bound, p95 over** |

Where the crowd frame goes (WebGPU Medium / High, ms): main draw 8.7 / 11.6, game logic 4.0 / 6.3, active-mesh
evaluation 3.1 / 3.8, animations 1.35 / 1.8, shadow map 0.5 / 1.0, post 0.15 / 0.3. The same 400 draws cost
**8.7 ms on WebGPU against 5.9 ms on WebGL2**: Babylon's WebGPU path pays more CPU per draw (bind groups, pipeline
lookup, `writeBuffer` per uniform buffer).

Top self time (CDP `Profiler`, 300 frames). No-crowd scenes (plaza / fields / storm, WebGPU Medium, all within 1 %
of each other): `_evaluateActiveMeshes` 4.2–4.4 %, `writeBuffer` 3.1–3.7, `render` 3.0–3.6, `bindForSubMesh` 2.0–3.3,
`setVertexBuffer` 1.7–1.9, `_setTexture`, `_preActivate`, `isReadyForSubMesh`, `_draw`, `_updateOwnerKeyed`
(fields/storm: the animated observers). All Babylon render submission: nothing of ours stands out.
Crowd (WebGPU Medium): `_evaluateActiveMeshes` 3.1 %, `writeBuffer` 2.6, `lodAnimate` 2.2 (≈ 0.6 ms: called once
per animatable, thousands of them), `render` 2.2, `bindForSubMesh` 2.1, `setVertexBuffer` 2.0, `AnimationGroup.stop`
1.8 (a scan of every active animatable per stop), `_setVertexState` 1.2, `_setTexture` 1.2, `_interpolate` 1.1.
Inclusive, ours: **skill hit effects 4 % (Medium) / 8.6 % (High) = 1.1 / 3.1 ms a frame** (a new Babylon mesh per
effect node per hit, its dispose a splice through ≈ 3,700 scene meshes, three vertex uploads per batch per frame),
entities 1 ms, name plates ≈ 0.45 ms (0.27 of it parsing each label's CSS transform back), shader/pipeline
creation ≈ 0.5 ms (alpha-tested outfit/crowd meshes re-preparing effects while the crowd budget re-merges).

## Fixed (each with a switch in apps/game/src/world/perf.ts for A/B; all on)

| # | Fix | Files | Profiled cost before → after (ms / frame, crowd) |
|---|---|---|---|
| 1 | **Hit-effect batch pool**: an ended effect's batch meshes wait hidden (≤ 8 per material × kind × geometry) for the next effect instead of create + dispose | packages/fx/src/renderer.ts (`FxLibrary.poolLimit`, opt-in), world/skill-fx.ts, features/skills.ts | effect drop 1.0 → 0.23 (High), 0.38 → 0.17 (Medium) |
| 2 | **Empty effect batches skip their uploads** (nothing drawn now nor last upload) | packages/fx/src/renderer.ts (`FxLibrary.skipEmptyUploads`) | batch uploads 0.31 → 0.05 (Medium); skill-fx total 3.1 → 2.0 (High), 1.1 → 0.8 (Medium) |
| 3 | **Name plates keep their anchor as numbers** instead of reading `style.transform` back and regex-parsing it | world/nameplates.ts (`setLabelAnchor`), world/entities.ts | `labelAnchor` 0.27 → 0.0 |

Nothing changes on screen (same meshes, materials, positions). Tests: packages/fx/test/renderer.test.ts (pool reuse,
no pool by default, full pool disposes, empty upload skip), apps/game/test/perf-audit.test.ts (anchors).

Interleaved A/B, 100 players (each switch off/on with the others on, medians of 4 pairs on a loaded PC; `all` = every switch, 6 pairs on a quiet PC):

| Config | Arm | off p50 / p95 | on p50 / p95 | machine CPU % mean (max) / min free MB |
|---|---|---|---|---|
| WebGPU Medium | fxPool | 18.2 / 26.2 | 17.0 / 26.2 | 41 (100) / 16 |
| WebGPU Medium | fxSkipEmpty | 19.1 / 32.7 | 17.9 / 26.7 | 41 (100) / 16 |
| WebGPU Medium | plateAnchor | 19.0 / 28.7 | 18.2 / 27.1 | 41 (100) / 16 |
| WebGPU High | fxPool | 24.1 / 36.7 | 22.0 / 33.1 | 64 (100) / 68 |
| WebGPU High | fxSkipEmpty | 23.6 / 39.2 | 23.0 / 34.5 | 64 (100) / 68 |
| WebGPU High | plateAnchor | 23.1 / 34.3 | 22.2 / 32.6 | 64 (100) / 68 |
| **WebGPU Medium** | **all three** (6 pairs, quiet PC) | 18.4 / 29.5 | **17.0 / 24.7** (−8 % / −16 %) | 19 (34) / 820 |
| **WebGPU High** | **all three** (6 pairs, quiet PC) | 24.5 / 35.8 | **22.2 / 32.7** (−9 % / −9 %) | 20 (37) / 275 |

Read the A/B with the machine column in mind: another job pushed the PC to 100 % and 16 MB free RAM during these
runs, so single pairs swing ± 5 ms. The profiled per-function costs above are the firmer evidence.

## What is left (the crowd is still over 16.7 ms p95)

Ranked by size; none is a quick safe fix, so none was built here.

1. **Draw count × Babylon's per-draw CPU (8.7–11.6 ms).** The crowd tier draws 135 far characters in **116
   batches** (16 VAT kinds): almost one draw per character. Batching them by kind (+ an atlas/texture-array for the
   outfits) would take ≈ 100 draws off; that is CHARACTERS.md P1's crowd work. On WebGPU, Babylon's snapshot
   rendering (`snapshotRenderingMode = FAST`) or render bundles for the static world would cut the per-draw cost;
   needs a check that the world's per-frame uniform changes survive it.
2. **Animation bookkeeping (≈ 2 ms):** every actor's groups stay started (165 playing groups → thousands of
   animatables); `lodAnimate` is called for each every frame, and each `AnimationGroup.stop()` scans all of them.
   Crowd-tier members (drawn by VATs) could keep their clip state without Babylon animatables.
3. **Shader/pipeline creation during the crowd (p95 spikes):** outfit merges are rebuilt (476 merges in ~3 min) as
   actors move between tiers; hysteresis in crowd-budget.ts / crowd-tier.ts would stop the churn.
4. **Hit effects** are still ≈ 2 ms on High (24 other-fight effects allowed, CPU particles): lower High's `otherHits`
   cap (world/fx/quality.ts) or skip effects off-screen / beyond ~40 m.

## GPU

No scene is GPU-bound: ≤ 4.9 ms GPU at 1080p High with 100 players. Resolution scale, shadows, post, grass and
weather are not the problem on this PC; no upscaling change is needed for it. For weaker GPUs the existing
settings already apply. Recommendation: **when a crowd is in view, WebGL2 is faster than WebGPU on this machine**
(15.4 vs 19.0 ms p50) because of the per-draw CPU; keep WebGPU the default but do not assume it is the faster path
until item 1 lands.

## Open

- One WebGPU storm run (instant storm, 13 s in) **reloaded the page** (CDP "target navigated"); two later storm runs
  did not. Possibly the GPU-loss guard (gpu-loss.ts reloads on a lost device); not reproduced, no log line.
