# Overall Pass: the walking / camera-turn stutter (2026-10-10)

The report: "the game stutters when walking and turning the camera, even on WebGPU, at any graphics setting incl.
Ultra." Stutter is spikes, not the average, so this pass measures every frame of a fixed route and asks what ran in
the slow ones. (Item 0 of the pass, same day: the game is WebGPU only; engine.ts, gpu-loss.ts, gpu-help.ts.)

**Answer: the spikes are the GPU process compiling render pipelines, not our JavaScript.** Walking and turning bring
meshes with materials not drawn before (streamed regions, characters, plants) into view; Babylon 9.28 makes each new
WebGPU render pipeline at its first draw with the synchronous `createRenderPipeline`, Chrome compiles it (WGSL → HLSL
→ DXIL → driver PSO) on the GPU process's main thread, and the frame waits 100–470 ms. On the route, 29 of the 39
frames over 33 ms came in the 3 frames after (or with) a new pipeline, with only 15–40 ms of JS in them. Fixed: in play
those pipelines are made in the background and the draw waits a frame or two (`PERF.pipelinesInPlay`).

## Method

`pnpm charbench --route [--alloc] --bots 8 --configs webgpu-medium` (apps/server/src/cli/charbench.ts; the page is
`?bench=1`, apps/game/src/debug/route-bench.ts + frame-probe.ts; zero cost when off: the probe wraps methods in place
only on a bench page). The route: noon, clear weather held, the bench character at the Jangan plaza; 6 s standing
with the camera orbiting 90°/s; the walk out of Jangan to the Grassland place (≈ 330 m as 30 m waypoints, the server's
path; a blocked waypoint is reached by a GM hop and counted) with the camera orbiting 30°/s; 6 s orbiting in the
grass; then the grass drawn / hidden, interleaved (uncapped frames). Headless Chrome on the real GPU (RX 9060 XT),
1920 × 1080, DPR 1, production build without minification, the display's own frame pacing (headless paces at ≈ 30 Hz,
so the frame p50 of ≈ 31 ms is the pacing; the CPU part and the spikes are the measure).

Per frame the probe records: Babylon's phases (`bjs.animations`, `bjs.activeMeshes`, `bjs.renderTargets(shadows)`,
`bjs.mainDraw`, `bjs.post`, `bjs.endFrame(submit)`), the world screen's frame (`game.frame` ⊃ `entities.*`, `effects`,
`world.update` ⊃ `world.<part>`, `stream.*`, `grass.*`; `minimap`, `feature.<name>`, `graphics.frame`, `crowd.*`), every
other scene observer by its first source line, the network handler per message type (`net.<t>`, between frames:
`outside.*`), new WebGPU pipelines and bind groups, the JS heap; the browser's long animation frames (LoAF, with script
attribution and style/layout) and long tasks; `--alloc` adds V8's sampling heap profile of the run (top allocators).

The PC was shared with four other helpers' benches and builds: two runs died of a lost device (D3D12 out of memory,
1 GB free RAM) and one ran at 99 % machine CPU (all costs ≈ 2×). The numbers below are from runs at ≈ 20 % machine
CPU; each run's JSON has its machine CPU and free RAM (`work/tmp/routebench/<run>/`).

## Where the time goes (before the fix; WebGPU Medium, 8 bots, 2082 frames)

Ranked by time in the frames over 33 ms (the stutter), then the mean (ms per frame):

| # | System | mean | p95 | max | in spike frames | Notes |
|---|---|---|---|---|---|---|
| 1 | **GPU-process pipeline compiles** (not JS) | – | – | 469 | 29 of 39 spikes | 55 new pipelines on the route; spike frames hold 15–40 ms of JS |
| 2 | `bjs.mainDraw` (draw submission) | 4.18 | 8.9 | 94 | 366 | Babylon's per-draw CPU, ≈ 300 draws |
| 3 | `net.despawn` (between frames) | – | 21.8 | 94–131 | 160 | one despawn now and then; not Babylon's disposal (mesh/node disposes ≤ 1.8 ms) |
| 4 | `bjs.activeMeshes` | 2.26 | 3.7 | 8.8 | 155 | |
| 5 | `game.frame` | 1.5 | 3.0 | 8.4 | 123 | world.update 0.65, entities 0.22, skills 0.14, crowd 0.11 |
| 6 | `bjs.animations` | 0.87 | 1.6 | 5.7 | 68 | |
| 7 | `bjs.renderTargets(shadows)` | 0.59 | 0.9 | 2.8 | 35 | one 91 ms frame in a 20-bot run (a shadow effect compiling) |
| 8 | grass (`world.scatter` ⊃ `grass.*`) | 0.31 | 1.6 | 3.8 | 15 | see below |
| 9 | stream (`stream.*`) | 0.05 | 0.1 | 5.4 | 11 | one job can overrun the 4 ms budget (11.6 ms seen) |
| 10 | crowd plan / outfit merge | 0.1 | 2.6 | 5.5 | 18 | 20 bots: `crowd.plan` 28 ms, `actor.setOutfitMerge` 19 ms max |

GPU frame time p50 2.2 / p95 3.1 ms: the GPU itself is never the limit. Style and layout in long frames < 1.3 ms; long
tasks 9 (max 101 ms).

**Garbage**: ≈ 3.3 GB freed in 68 s (≈ 49 MB/s; 102 heap drops), heap ≈ 2 GB. Sampled allocations: the licensed
body's clip retarget ≈ 30 % (three/retarget.ts `qmul`, `pose`, `worldOf`; 13 % of everything was the iterators of
`qmul`'s array destructuring), Babylon's shader preprocessing ≈ 25 % (effects compiled while walking: `ProcessIncludes`,
the PBR material's defines), the grass bake ≈ 4 %.

**Grass** (asked precisely; no redesign here): CPU per frame mean 0.31 ms, p95 1.6, max 3.8 (`grass.update` 0.30,
`grass.bakeSlice` 0.19 mean / 3.4 max, ring update / upload ≤ 1 ms); under the 20-bot run on a loaded machine one
`grass.bakeSlice` took 37 ms. GPU: drawn 2.00 ms vs hidden 1.95 ms a frame in the fields view (≈ 0.05 ms, Medium, noon);
the CPU frame with / without the grass meshes is within noise (5.3–5.9 vs 5.6–5.7 ms). Grass is not the stutter.

## Fixed

| Fix | Files | Switch |
|---|---|---|
| In play, a mesh draw whose WebGPU pipeline is missing has it made with `createRenderPipelineAsync` (Dawn's worker threads) and is skipped until it is: the mesh appears a frame or two later instead of the frame waiting for the GPU process. Mesh draws only (main pass, shadow maps, prepasses); full-screen passes draw as before. The warm-up's session machinery (P-STALL), now on for play too. | apps/game/src/screens/pipelines.ts | `PERF.pipelinesInPlay` |
| Quaternion multiply without array destructuring (the retarget's iterator garbage, 13 % of all allocations) | three/retarget.ts, three/retarget-clips.ts | – |

## Before / after

The same route, back to back on one build, WebGPU Medium, 8 bots; "before" = `--query perfoff=pipelinesInPlay`
(the fix off from the first frame). Both runs at ≈ 70 % machine CPU (the other helpers' work; the PC never got quiet
for a whole pair), so the absolute CPU numbers are ≈ 2× the quiet run above; the comparison is the pair.

| Run | sync pipelines | frames > 250 ms | 100–250 ms | 33–100 ms | p99 | max | stalls (> 100 ms, < 50 ms JS) | spikes near a pipeline |
|---|---|---|---|---|---|---|---|---|
| before (fix off) | 46 | **15** | 28 | 168 | 212 ms | 658 ms | 35 | 25 |
| after (fix on) | **0** | **4** | 20 | 290 | 116 ms | 414 ms | 15 | 0 |

The long freezes the player feels (> 250 ms) dropped 15 → 4 and p99 halved; every remaining stall is unrelated to
pipelines (the machine at 100 % CPU with < 50 MB free RAM pages; the despawn hitch). The 33–100 ms band grew under
that load; a quiet-machine pair is still owed: `pnpm charbench --route --bots 8 --configs webgpu-medium` and the
same with `--query perfoff=pipelinesInPlay`. High (after, fix on): sync pipelines 0, GPU p50 4.7 ms.
Runs: `work/tmp/routebench/{before6,before8,after3,after2high}` (JSON with every spike, the probe's systems, LoAF).

## Round 2 (same day): the rest of the plan

| # | Finding | Fix | Files | Switch |
|---|---|---|---|---|
| 1 | **Despawn 94–150 ms** was the actor's teardown: every node's and mesh's dispose (≈ 45 an actor) calls `scene.stopAnimation(node)`, a scan of every running animatable of the scene (probe: `actor.dispose` p95 104 ms, inside it `bjs.mesh.dispose` 84 + `bjs.node.dispose` 66 ms a despawn) | one scan stops the actor's animatables, the per-node scans are skipped while it is torn down | three/models.ts `CharacterActor.dispose` | – |
| 2 | Pipelines still made when a mesh first comes into view (the round-1 skip hides it a frame or two) | **new meshes ahead of view**: a mesh added in play has its effects compiled in a 2 ms/frame pass (`isReady(true)`) and is drawn for up to 8 frames even out of view, as a ghost, so its pipelines are made in the background before the camera turns to it; installed by the warm-up (world entry, teleport, graphics switch) | screens/pipelines.ts `watchScene`, screens/warmup.ts | `PERF.prewarmNew` |
| 3 | Retarget: ≈ 35 % of the garbage | rebuilt clips cached per skeleton (the spec's content), not per body file object; the quaternion multiply without destructuring (round 1) | three/retarget-clips.ts | – |
| 4 | Stream jobs ran one job past the 4 ms budget | a frame starts no job that the recent jobs' average says would overrun (after half the budget) | world-render stream.ts `step` | – |
| 5 | Crowd plan bursts (4 merges + 3 outfits + 8 crowd joins in one frame: 28 ms with 20 bots) | a plan builds for 3 ms at most, the rest comes with the next plan 50 ms later | world/crowd-budget.ts | – |

The probe now also times nested work between frames (a despawn's parts), the features' entity hooks, and the
background pipelines (`warm`: in-play skips, prewarmed meshes).

### Before / after (quiet machine)

WebGPU Medium, 8 bots, the route; "before" = the round-1 baseline `before6` (19 % machine CPU), "after" = all fixes of
both rounds `r2after` (15 % machine CPU). (The paired `r2before` run with the pipeline switches off hit 67 % machine CPU
from other work and is not comparable; its despawns still showed `actor.dispose` 60 ms p95 with the dispose fix off.)

| | before | after |
|---|---|---|
| frames > 250 ms | 5 | **0** |
| frames 100–250 ms | 10 | **2** |
| frames 50–100 ms | 10 | 7 |
| frames > 33 ms | 39 | **22** |
| frame p99 / max | 64.7 / 469 ms | **33.2 / 104 ms** |
| pipelines made at a draw (sync) | 55 | **0** (115 in the background; 444 meshes prewarmed; 172 draws waited a frame) |
| stalls (> 100 ms with < 50 ms of JS) | 15 | **2** |
| despawn p95 / max | 21.8 / 94 ms | **2.8 / 55 ms** |
| stream job max | 5.4 ms (11.6 with 20 bots) | 5.2 ms |
| crowd plan max | 5.5 ms (28 with 20 bots) | 9.7 ms (8 bots, one plan) |
| long tasks | 9, max 101 ms | 5, max 103 ms |
| CPU per frame p50 / p95 | 9.1 / 16.7 ms | 10.1 / 20.3 ms |
| GPU per frame p50 / p95 | 2.2 / 3.1 ms | 2.2 / 3.6 ms |
| garbage | 49 MB/s; retarget 35 %, shaders 32 % | 60 MB/s; retarget **9 %**, shaders 50 % |

The prewarm costs ≈ 1 ms of CPU a frame on the route (its budgeted effect compiles and the ghost draws) and makes
more effects (meshes that never come into view are compiled too): the shader preprocessing's garbage is the largest
left. Runs: `work/tmp/routebench/{before6,r2after,r2before}`.

## Round 3 (same day): garbage, despawn, draws

Goal: no frame over 33 ms on the route and garbage well under 20 MB/s. **Not reached**; what was found and done:

| # | Finding | Done | Files / switch |
|---|---|---|---|
| 1 | **Shader garbage was respawn churn, not new looks**: only 15–21 effects are new over the whole route, but Babylon releases an effect (and its pipelines) when its last material goes, so every despawn / respawn of a look compiled it again (and its pipelines were skipped in play again) | compiled effects kept for the session (`Effect.PersistentMode`) | engine.ts, `PERF.effectsPersistent` |
| 1b | The prewarm compiled meshes nobody looked at (≈ 1 ms a frame) | only meshes within 140 m and the view + 90° are prewarmed; the rest wait in the queue | screens/pipelines.ts |
| 3 | In-play skips by mesh (the bench now names them): the siege stockade's props, the town folk's horse and parts, made hidden at load and shown later, when already in view | hidden meshes (also those made before the warm-up) wait in the queue until shown instead of being dropped | screens/pipelines.ts |
| 3b | The last despawn (50–70 ms under load): `AbstractMesh.dispose` walks every light's include / exclude lists and every shadow map's render list per mesh | the actor's animatables are stopped without a splice each; **sliced disposal over frames was tried and reverted**: four test suites (actor culling, idle corpses, ride, the W11 Low ↔ Medium switch) rely on an actor's meshes being gone right after its dispose | three/models.ts |
| 4 | Draw submission | **census** (route bench): plaza 125–215 plain draws, fields 50–455, and 0–1 geometry + material pairs drawn twice: the world is already batched / thin-instanced, instancing has nothing left to merge. **Snapshot rendering** (Babylon's FAST mode, `SnapshotRenderingHelper`) bakes the draw list; any change to the set of drawn meshes (frustum culling on every camera turn, streaming, characters, LOD and crowd switches) needs a re-record, i.e. almost every frame here: not adopted. Render bundles for the static world would need a separate per-region static pass (world-render) | route-bench.ts `drawCensus` |
| 5 | Garbage > 5 % | route-only sampling (the setup is now outside the sampled window): **no source is above 5 %** any more; the largest are PBR effect code injection 4.6–5.1 %, Babylon's `isReady` define strings ≈ 7 % together (materials re-checked every frame), the grass bake ≈ 8.7 % together (the grass task), pipeline lookups 3.4 %, the sky's prefiltered radiance 3.2 % | – |
| 2 | Character / outfit / weapon / rarity variant prewarm at character select | **not done**: the variants a session meets arrive as new meshes and go through the prewarm above; warming looks nobody wears yet would mean loading their models | – |

Garbage on the route: 49 MB/s (round 1) → 56 (round 2, the prewarm) → **33–36 MB/s** (round 3, persistent effects; the
two runs at the same 33–35 % machine CPU: 56.3 → 35.2). The route's own allocations (sampled, everything the V8
young generation collected included) are ≈ 45 MB/s with no source above 5 %.

Frames: the PC never stayed quiet for a whole run in round 3 (other helpers' builds and benches started mid-run,
33–90 % machine CPU, < 200 MB free RAM). The least loaded runs (`r3c`, `r3d`, 33–35 %): frames > 33 ms 37–43, > 50 ms
7–11, > 100 ms 2–4, none > 250 ms, p99 38–41 ms, CPU per frame p50 11.8–12.4 ms, sync pipelines 0. Every remaining
spike over 100 ms in those runs is a despawn (66–76 ms) or a frame whose JS took 100+ ms only under load. A quiet-machine
pair is still owed (`pnpm charbench --route --alloc --bots 8 --configs webgpu-medium`, one config per invocation,
≥ 4 GB free RAM). Runs: `work/tmp/routebench/{r3c,r3d,r3e,r3f}`.

## Round 4 (same day): despawn, hidden meshes, define checks, grass bake garbage

| # | Finding | Done | Files |
|---|---|---|---|
| 1 | Despawn: besides the lists, most of the remaining time was `releaseSubMeshes` (205 ms once under load): each submesh's draw wrapper released its effect, the effect its pipelines | an actor's meshes leave every light's include / exclude list and shadow render list in one in-place pass per list (a list it empties still notifies, as Babylon's splice would); with the persistent effects (round 3) the release no longer tears effects down. Despawn p95 **22.4 → 3.7 ms** in the pair below; one 52–57 ms despawn per route remains (`mesh.dispose` 40 ms in it) | three/models.ts `dropFromLightLists` |
| 2 | The in-play skips are the siege stockade (loaded after the warm-up, often already in view, `siege/stockade.ts`), the town folk's horse and parts, the licensed bodies' LODs | the hidden-mesh queue (round 3) stays; **not reached**: these meshes appear in view the frame they are made or shown, and a disabled mesh is never evaluated (the world's own active-mesh candidates list only enabled ones), so no ghost draw can warm it before. The skip is their first 1–3 frames (they appear a little later, nothing stalls) | – |
| 3 | "A material re-checked every frame": the bench counts PBR readiness checks with dirty defines: only ≈ 270 over the whole route (the Mangnyang parts, the crowd pages, the licensed bodies) – not it. The garbage is Babylon's `ShaderMaterial.isReady`, which builds its define list and joins it on every call, for every ShaderMaterial draw, every frame (grass, sky, ocean, terrain parts) | **not changed**: freezing those materials or caching the define string is safe only per material (defines follow mesh state: bones, instances, fog, clip planes) | route-bench.ts `dirtyLog` |
| 4 | Grass bake garbage | the edge warp's octaves read by index (its destructuring's iterators), the nav pick's distance inline instead of a closure per texel (the bake's occupancy test) | grass/bake.ts, nav/src/world.ts |

### Before / after (round 4, the switches off vs on, one build)

WebGPU Medium, 8 bots, the route. Both runs started on a quiet PC (< 20 % CPU, ≥ 8 GB free) but other helpers' work
pushed both to 65–70 % mean machine CPU during the run (matched). "Before" = `--query perfoff=pipelinesInPlay,prewarmNew,effectsPersistent`
(rounds 1–3's pipeline and effect work off; the other fixes have no switch).

| | before (switches off) | after (on) |
|---|---|---|
| frames > 250 ms | 3 | **0** |
| frames 100–250 ms | 14 | **4** |
| frames 50–100 ms | 10 | 19 |
| frames 33–50 ms | 57 | 193 |
| frame p99 / max | 63 / 872 ms | **51 / 159 ms** |
| pipelines made at a draw | 44 | **0** |
| stalls (> 100 ms, < 50 ms JS) | 15 | **4** |
| despawn p95 / max | 22.4 / 64 ms | **3.7** / 57 ms |
| CPU per frame p50 / p95 | 16.5 / 27.3 ms | 12.0 / 36.0 ms |
| garbage | 32.1 MB/s | 36.4 MB/s |

The long freezes are gone; the price is more frames between 33 and 50 ms: the prewarm's effect compiles (one
`isReady(true)` can take 15–19 ms despite the 2 ms budget: the budget is checked between meshes) and its ghost draws.
Goals not met: frames over 33 ms (216 under this load) and garbage under 20 MB/s (36). Runs:
`work/tmp/routebench/{r4before,r4after}`.

## Round 5: the prewarm's own cost, ShaderMaterial readiness

Round 4's pair showed the prewarm costing more 33–50 ms frames than it saved. Changes:

| # | Change | Files / switch |
|---|---|---|
| 1 | **The prewarm in idle time**: effect compiles (Babylon's shader processing, 5–20 ms, not splittable) run in `requestIdleCallback`, one per idle period and only with ≥ 8 ms of it left, never inside a frame; the per-frame work is only the held meshes. A held mesh (ghost-drawn out of view) is let go as soon as a frame's ghost draws start no pipeline for it (it was held up to 8 frames), at most 16 at once. Pipelines stay `createRenderPipelineAsync` (Dawn's worker threads) | screens/pipelines.ts, `PERF.prewarmNew` |
| 2 | **ShaderMaterial readiness from a signature**: Babylon rebuilds and joins the define list on every `isReady` of every ShaderMaterial draw; the cache keeps, per draw wrapper and mesh, what that call reads (instances, thin instances, vertex colour, skeleton and bones, baked VAT, alpha test, fog, log depth, the scene's clip planes, the material's defines and attributes, the effect it validated) and answers `true` while all of it is unchanged and the effect and textures are ready; morph targets, vertex pulling, custom name resolvers and multiview go to Babylon | three/shader-ready-cache.ts (+ test), `PERF.shaderReadyCache` |
| 4 | **Hidden meshes compiled without being shown**: the idle prewarm calls `isReady(true)` on disabled / invisible meshes too (their material and shadow depth effects for their mesh state), without enabling them; their pipelines then follow at the first draw in the background | screens/pipelines.ts |
| 3 | The last despawn: the probe now times a mesh dispose's parts (active / rendering lists, caches, submeshes, `Node.dispose` with its dispose observers) | debug/frame-probe.ts, route-bench.ts |

The bench also stops (and closes its Chrome) below 900 MB free RAM: the shared PC crashed twice mid-bench.

**Measured (one run, `r5after`, 15 % machine CPU, 2 bots, 1280 × 720 for memory)**: CPU per frame p50 9.3 / p95 17.4 ms
(round 4 after: 12.0 / 36.0), no pipeline made at a draw, despawn p95 2.6 / max 29 ms (the probe: `mesh.dispose` 18,
`Node.dispose` with its dispose observers 11, `freeRenderingGroups` 6 ms in that one), 1414 meshes prewarmed in idle
time. **But the GPU frame time is now p50 28 / p95 39 ms** (2.2 / 3.6 in every earlier run): the frames are GPU-bound
(456 over 33 ms, 51 over 100 ms with 10–20 ms of JS). Not attributed yet: the isolation runs (`perfoff=shaderReadyCache`,
`perfoff=prewarmNew`) and the switches-off pair could not finish: **the bench page now needs 7–7.7 GB** (Chrome's GPU
process 5–5.3 GB, the renderer 1.7–2.4 GB) and the shared PC has 7–9 GB free, so the memory guard stopped them, with
the switches off as well (so the footprint is not round 5's). Garbage 54 MB/s in that run: the idle prewarm compiles
every hidden mesh (1414, LODs included; PBR code injection 16.5 % of the sampled allocations).

## The 28–49 ms GPU frame (2026-10-11): not the game, the bench's GPU

Every run since the PC's crash and reboot ran on the **integrated** GPU: the adapter the bench logs went from
`rdna-4` / "AMD Radeon RX 9060 XT" (all runs before, GPU p50 2.2–2.4 ms) to `rdna-2` / "AMD Radeon(TM) Graphics" (the
Ryzen's iGPU, 512 MB, textures in shared system RAM) from `r5after` on. That is both symptoms: the GPU frame (28 ms at
1280 × 720, 49 ms at 1920 × 1080: fill-rate bound; post, shadows, render targets, particles, grass and lights each
change it by 1–4 ms, the terrain and the objects carry it) and the 3.2–5.3 GB Chrome GPU process (the iGPU's "video
memory" is system RAM). The round-4 build (`70a435c`, built in a separate worktree, today's assets) measures the
same 17 ms on the iGPU, so neither round 5 nor the later commits caused it; the isolation runs agree
(`perfoff=prewarmNew`, `perfoff=effectsPersistent`: GPU p50 49 ms both).

Chrome on Windows ignores WebGPU's `powerPreference` (engine.ts) and `--force_high_performance_gpu` did not change
it; the adapter follows Windows' per-app graphics preference / the display's adapter. Both video controllers report
OK. Players on dual-GPU PCs can land on the iGPU the same way (the first-run preset already treats an AMD APU as
integrated). The bench's numbers need the discrete GPU back (Windows Settings → Display → Graphics → Chrome → High
performance, or the monitor on the RX 9060 XT) before any further GPU comparison.

## Round 6: back on the RX 9060 XT (2026-10-11)

With Chrome set to the graphics card (Windows' graphics preference) the bench logs `rdna-4` / "AMD Radeon RX 9060 XT"
again and the GPU frame is p50 2.4–2.6 / p95 3.7 ms in every run. WebGPU Medium, 8 bots, 1920 × 1080, the route, one
build, each run under the bench lock at 11–19 % machine CPU:

| Run | frames > 33 ms | > 50 ms | > 100 ms | p99 | max | CPU p50 / p95 | despawn p95 / max | garbage |
|---|---|---|---|---|---|---|---|---|
| r7before: all four switches off | 27 | 20 | 11 | 44 ms | 559 ms | 9.7 / 16.3 | – | 31 MB/s |
| r8before: pipelinesInPlay, effectsPersistent, shaderReadyCache off | 35 | 25 | 13 | 66 ms | 457 ms | 9.1 / 16.0 | 1.4 / 40 ms | 44 MB/s |
| r7noCache: prewarm on, readiness cache off | 23 | 6 | 1 | 34 ms | 105 ms | 9.5 / 17.6 | – | 40 MB/s |
| r7noPrewarm: prewarm off, the rest on | 13 | 5 | 1 | 32 ms | 104 ms | 8.8 / 16.6 | 9.6 / 63 ms | 31 MB/s |
| **r8after: the new defaults** (prewarm off) | **21** | **9** | **0** | **33 ms** | **99 ms** | 9.2 / 17.8 | 2.9 / 41 ms | 33 MB/s |
| **r8after2: the same again** | **17** | **5** | **0** | **32 ms** | **99 ms** | 9.0 / 16.8 | 1.6 / 35 ms | 30 MB/s |

- **The prewarm is off by default** (`PERF.prewarmNew`): with the in-play pipeline rule and the persistent effects it
  added frames over 33 ms (23 with, 13 without) and saved no stall.
- Every frame over 100 ms is gone (11–13 with the switches off); p99 halves; the GPU frame is unchanged (2.5 ms).
- Despawn: the scene's active-mesh and rendering-group lists are now reset once per actor (they were 11 ms of a 62 ms
  despawn). One despawn per route still takes 35–41 ms: the actor's nodes' own dispose observers and child recursion
  (`Node.dispose` 17 ms inclusive in the 62 ms one); next to look at.
- The remaining frames over 33 ms (17–21) are mostly a 99 ms frame with 15 ms of JS (a GPU/compositor wait, no
  pipeline made at a draw) and the one despawn.
- Chrome's memory on the card: GPU process 2.0–3.0 GB, renderer 2.7–2.8 GB (JS heap ≈ 2 GB), not the 1.5 GB target:
  textures Babylon tracks are ≈ 1.1 GB (the licensed bodies' 2048² textures uncompressed: 280 MB), the rest is buffers,
  pipelines and Chrome's own; no growth over a 70 s watch (no leak). Still open.
- **Integrated-GPU notice** (gpu-integrated.ts, gpu-help.ts): when the browser draws with the processor's graphics, a
  dismissible notice explains Windows Settings → System → Display → Graphics → High performance; once per session on a
  likely dual-GPU PC (a desktop processor's minimal graphics) until "Don't show again", once ever otherwise.

## Round 7: memory, the 99 ms frame, the despawn

Measured in the world (8 bots, Medium, 1920 × 1080, RX 9060 XT) with V8's sampling heap profiler from before the page
loads (work/tmp/heapwatch.mjs: live allocations after a forced GC, by allocating function) and Babylon's texture list:

| What held the memory | Size | Fix | Switch |
|---|---|---|---|
| The licensed bodies' embedded images: every outfit glb carries its own copy of the same 2048² body, face and hair images, uncompressed | 73 textures, 1.56 GB of GPU memory | shared by image content, made at 1024² on Medium and below (three/gltf-texture-share.ts): **25 textures, 149 MB**; Babylon's tracked textures 2.54 → 0.95 GB | `PERF.licensedTextureShare` |
| Every effect's processed shader source (kept for a context restore WebGPU never does here; the persistent effects keep them all) | ≈ 200 MB JS | dropped for ready effects every 10 s (three/cpu-copies.ts), with the raw data of 2D-array / 3D textures | `PERF.trimCpuCopies` |
| A Vector3 per vertex on every mesh whose bounding info was refreshed (Babylon's `_positions`, for picking; never read by the game) | ≈ 137 MB JS | not built (three/positions-trim.ts); a pick builds points from the geometry on demand | `PERF.trimPositions` |
| The retargeted clips: a Quaternion per joint per frame | ≈ 165 MB JS | the keys inside runs of equal values dropped (exact playback) | – |

**JS heap 2.1 GB → 0.94 GB** after a GC (the renderer process 3.2 → 1.5–1.9 GB). Left: the retail clip packs' keys
(≈ 110 MB), the retargeted clips (≈ 90 MB), the encoded glTF images the batcher reads (`_buffer`, kept on purpose).

**Chrome's GPU process stays ≈ 2.7 GB** with the textures down by 1.6 GB: on the discrete GPU the textures live in
video memory, so its working set is mostly Chrome / Dawn (upload and staging heaps, pipelines, shader caches), not
something the page holds directly. The < 1.5 GB target is not reached; next: Chrome's own memory dump
(`chrome://tracing` memory-infra) to see which Dawn allocator holds it.

**The 99–108 ms frame** at ≈ 15.9 s into the route (every run, the same moment): the long animation frame shows 98 ms of
script in the render-loop callback while the frame itself (begin → end) took 15–20 ms. The probe now also times the
engine's `beginFrame` and the whole `_renderLoop` (debug/frame-probe.ts) to find what runs around the frame; not yet
measured (see below).

**Despawn**: Babylon's `Node.dispose` has no guard, and `CharacterActor.dispose` disposed each of its nodes after its
parent's dispose had already taken it: most nodes went through the whole teardown twice. Now skipped when already
disposed. With the round-6 list batching the remaining despawn was 35–56 ms (one per route); after this change: not
yet measured.

**Not measured yet**: every run after these changes was stopped by the bench's memory guard (the page plus its server
need ≈ 5.5 GB, the PC had 6–7 GB free with another helper's Blender at 1 GB) or kept waiting for the lock. Runner:
`work/tmp/routebench-r11.sh` (4 bots, switches off vs on).

## Round 8: the walking stutter was the own character's position, not the frame (2026-10-12)

The report after rounds 1–7: "still a weird stutter when walking and running, more when turning the camera" (Ultra,
3440 × 1440, 47 fps on a 240 Hz screen, 13 ms ping). Measured per frame instead of per spike: the own character's
drawn position, the camera, the character's place on screen (`work/tmp/smooth/run4`: `pnpm charbench --steps` built by
`work/tmp/smooth/tools/mk-steps.cjs`, read by `analyze.cjs`): key walk W held 3 s straight then 8 s with the camera dragged through the camera's own input
path, 8 ms injected each way ≈ the live ping, the frame rate held at 47 fps on the 240 Hz screen with `engine.maxFPS`,
two interleaved rounds per arm, `__sroPerf` switches; Low 1280 × 720 because the PC had no RAM for Ultra next to
another helper's Blender — the cause below does not depend on the preset).

**Cause** (client only; no server change can fix it): `EntityView.setMove` measured a correction against `pos`, the
position of the *last frame*. (1) During a key walk every own `move` echo is applied by the world screen and then
overridden by the key walk's prediction in the same handler; the second call read the stale `pos`, so the drawn
character jumped ahead by the prediction's lead over the server (the corner the server's chord cuts while turning) and
glided back over ≈ 0.25 s — with the camera dragged an echo arrives up to 10 times a second, so every frame carried an
offset of up to 30 cm. (2) The key walk's 100 ms timer re-planned between frames: the new segment began after the last
frame drawn, so the correction pulled the character back by the walk in between (up to 11 cm at 47 fps, every
200–400 ms even walking straight). The camera followed the logical position, so both showed as the character shaking
on screen.

| per frame (47 fps, 2 rounds) | before: walk straight | before: walk + turn | after: walk straight | after: walk + turn |
|---|---|---|---|---|
| drawn character, step error vs its speed, p95 / max | 6.2 / 11.1 cm | **21.4 / 27.0 cm** | 0.22 / 0.33 cm | **0.22 / 1.6 cm** |
| frames with a correction offset > 1 cm (max) | 59 of 125 (10.8 cm) | 359 of 360 (30.3 cm) | 0 | 0 |
| character on screen, frame-to-frame jerk p95 / max (720p) | 2.9 / 5.0 px | 7.9 / 9.8 px | 0.11 / 0.33 px | 0.06 / 0.15 px |
| drawn speed (median, true 5.5 m/s) | 5.2–5.5 | 4.3–4.7 | 5.5 | 5.5 |
| frame time p50 / p95 / max | 20.8 / 25.0 / 25.1 | 20.8 / 25.0 / 25.1 | 20.8 / 25.0 / 25.1 | 20.8 / 25.0 / 25.2 |

Fixed (`PERF.smoothMotion`, on): the correction is measured at the current server time against where the view's own
state has it then (its move, else its standing point); the key walk's timer only sends (`KeyMover.tick`), planning
stays on frames; the camera target sits on the *drawn* character on the ground plane (no dt-scaled lerp: its lag
changed with every frame time, ≈ v × Δdt = 2 cm between a 21 and a 25 ms frame), only a jump of the focus (the switch
to the steered mob) glides out, frame-rate independent; the height still eases (1 − e^(−10·dt)).
`PERF.frameClock` (on): the world frame reads the frame's own begin time (`document.timeline.currentTime`, equal to the
rAF time in every frame measured) for the views and dt; at Low the world's frame callback ran 0.4–0.6 ms (sd 0.1–0.3)
after it, so it made no measurable difference there; it removes the dependence on how much work runs first at Ultra.
Tests: `apps/game/test/movement.test.ts` (corrections). Not changed: the server clock's offset step at a pong (≤ 1 step
per arm, sub-cm here).

## Plan (next)

0. **Prewarm cost** (the 33–50 ms band): compile at most one new effect per frame (an effect compile is the unit, not a
   mesh), and skip the ghost draws for meshes whose effect and pipelines another mesh already made.
0b. **ShaderMaterial define strings** (≈ 7 % of the garbage): cache `isReady` per material and mesh while nothing it
   reads changed (a version counter set by the code that changes their defines), or freeze the static ones.

1. **Despawn** (50–70 ms under load): remove an actor's meshes from the lights' lists and the shadow render lists in
   one pass before its dispose (each mesh's dispose then finds nothing to splice), or make the disposal asynchronous
   with the four tests above taught to wait for it.
2. **Hidden-then-shown meshes** (the stockade, the town folk): prewarm them while hidden (a ghost draw with the mesh
   briefly enabled) so their first visible frame has its pipelines.
3. **Materials re-checked every frame** (`isReady` define strings ≈ 7 % of the garbage): find which material is marked
   dirty each frame.
4. **Draw submission** (`bjs.mainDraw` 4–9 ms, Babylon's WebGPU per-draw cost): fewer draws (batching,
   docs/BATCHING.md) or render bundles (Babylon's snapshot rendering) for the static world.
