# Wave plan 7: wave 11, "a world boss on her tiger, and a town that lives"

This plan merges two fact-checked specs into one build order for wave 11:

- **docs/UNIQUES.md** (item 1): Tiger Girl rides her tiger (the ridden-mob composite), and uniques become world bosses:
  a server module with persisted timers, server-wide appear and defeat announcements, a boss fight tuned for 4
  level-20 friends, our own unique loot, GM commands.
- **docs/TOWN_LIFE.md** (item 2): a living Jangan: deterministic client-side townsfolk drawn with baked animation
  textures (VAT) and thin instances, animals, cloth that sways inside the batch, smoke and steam, town sounds and the
  bell, warm night light, dressing, the pond, and a gated B2 town texture batch.

It also takes stock of the polish pass's **"grass to the horizon"** (docs/GRASS_FAR.md, §0.2) and of the user's
latest message about the jump (§0.3).

The user's words, verbatim:

> Tiger Girl is a unique monster, in retail unique monsters are world bosses so she needs announcement upon spawn etc.
> Also shes riding a tiger, the tiger doesnt show up in game, so she looks likes shes floating. Fix her.

> Let's also make Jangan town for better, beautiful, and a living town. Lets bring it to life, it looks dead right
> now, static, and empty.

> also jumping needs to be a bit higher

Fishing, swimming and underwater are **wave 12** (the user), not this wave (§11).

**The user is away and delegated every decision.** Wherever there is a choice, this plan takes the option it would
mark "(Recommended)" and writes it as a decision with a one-line reason (§2). Only what truly needs the user is left in
§8 and §10, each with the default used meanwhile.

This plan does what WAVE_PLAN6 did for wave 10:

- it settles every place where the two specs (and the polish pass still in the tree) would give a file or a piece of
  state two owners (§2);
- it merges the wire additions into one protocol list and fixes the one migration (§3);
- it lands **the seams first** (§4), on disjoint packages, before any lane;
- it holds the sum of both items against the measured wave-10r gate (§5), with the new G1 scene: **the plaza with 20
  players plus the crowd**;
- it orders the lanes, the re-converts, the integration, the bench, a hunt with lenses, the fixers, a final gate and an
  independent verify (§6), and gives one scope-cut order with a never-cut list (§7), what the user approves (§8),
  risks (§9), open questions (§10) and the deferred list (§11).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads
its spec sections and this plan's row for it.

**Tags** (as in WAVE_PLAN6):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-01, or measured by a spec's prototype
  and re-derived by its fact-check, or measured at the wave-10r gate. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes. The user may overrule it.

**Repo state when this was written [confirmed: `git log`, `git status`, file times, 2026-10-01 09:51].**

- HEAD `f56d175` ("Wave 10r final: hunt fixes, budgets G1 pass, G2 pass"). On top of it, **the polish workflow's
  working tree is uncommitted**: 54 modified files (+2,120 / −319 lines) and new ones, in `apps/game/src/{screens/charselect,
  screens/warmup, stage/host, stage/types, three/models}.ts`, the new `screens/pipelines.ts` and `three/light-cap.ts`,
  `apps/server/src/gamedata.ts` (zone names), `content/coast`, `content/moves/*/jump*.json`, `content/environment/`,
  `content/texpipe`, `packages/convert/src/{cli, data/zones, tools/export-data, world/convert-world,
  world/coast/*}.ts`, the new `world/environment-overrides.ts`, `packages/texpipe`, and in
  `packages/world-render/src/{grass/*, ocean/*, shore/*, coast/chunks, textures}.ts` with the new grass ring files.
- **The build of wave 11 starts from the polish pass's commit** [decision, D1]: its files overlap this wave's seams
  (`three/models.ts`, `stage/host.ts`, `convert-world.ts`, `cli.ts`, `grass/*`). Nothing in this plan waits for it; only
  the step-0 agents do.
- The server database has **9 migrations** (`SCHEMA_VERSION = MIGRATIONS.length`; the user's `work/server/game.db` is at
  `user_version` 9) [confirmed: UNIQUES fact-check F1, `pnpm tsx`, sqlite on a temp copy]. The polish tree does not
  touch `db.ts` [confirmed: `git status`].
- Scratch the lanes port from: `work/tmp/uniques/` (`proto/`, `why-no-tiger.ts`, `dryrun.ts`, `factcheck/*.py`,
  the shots and the GIF), `work/tmp/town-life/` (`lab/town-lab.ts`, the census scripts, `out/` scratch conversions,
  `shots/ab_*.json`). This plan's arithmetic is `work/tmp/w11-plan/budget.py`; its preview sheet is
  `work/tmp/w11-preview.png` (also in Dropbox `wave11/w11-preview.png`), made by `work/tmp/w11-plan/make_preview.py`.

---

## 0. Summary

1. **Two items, one seam step.** Five foundation agents run first and in parallel, on disjoint packages (§4):
   **W11-P** (`packages/shared`: `uniqueNotice`, `MobDef.ride`, `UniqueDef`, the town file types; the mock),
   **W11-SV** (every `apps/server` seam the uniques module needs: the Spawner's refusal, migration 10, `Mob.damageMul`
   and `corpseMs`, the kill path's owner group and drop override, the summon policy hook), **W11-S** (every
   `packages/world-render` seam: `World.town`, the `'town'` tag, the `+sheen` cloth pivot, the cloth define slot, the
   life part's float landing, the post's temporal fallback hook, the water ripple points), **W11-G** (every `apps/game`
   seam: the `companion` and `lodLeader` on `CharacterActor`, the ride load hook, the `uniqueNotice` dispatch, the town
   clock, threats, click and alarm hooks, the `townLife` setting and Options row), **W11-CV** (the converter: `MobDef.ride`,
   the sound cues and export list, the town hook sites in `convert-world.ts`, the `town` CLI verb). Data work that needs
   no code starts at once (TL-A2 Blender clips, TL-K census).
2. **One owner per shared module** (§2.1, §2.2). The two items barely touch each other: Tiger Girl lives in the
   server, `models.ts`/`entities.ts` and a new client file; the town lives in `packages/world-render/src/town/**`, the
   converter and content. They meet in exactly three places, all settled in step 0: `screens/world.ts` (the notice's
   chat line and the town's alarm, D9), `packages/shared` (W11-P writes both items' types, D6) and the sound export
   list (W11-CV, D12).
3. **Protocol (§3):** one server message, `uniqueNotice`; no client request; no `ServerInfo` change. The town adds
   **no** wire message (it is a pure function of the shared server clock). **One migration: 10**, table `uniques`.
   One server config switch (`UNIQUES`), one GM command (`/unique`).
4. **Budgets (§5), against the measured wave-10r gate:**
   - **G1, Medium < 16.7 ms p95 everywhere, now including the plaza with 20 players plus the crowd**: the plaza alone
     goes 3.6 → ≈ 4.9–5.9 ms (WebGPU); the 20-player plaza 13.4 (repeats 13.0–15.1) → **≈ 13.7–16.2 ms** with the
     crowd giving way to players (−3 townsfolk per player beyond 5, ≥ 15), 14.0–16.8 undivided [projected]. That is the
     tightest scene in the game; LAB-11 decides, and cut item 20 is the fallback.
   - The Tiger Girl fight: a party of 4 ≈ 7.2 / 5.1 ms (WebGPU / WebGL2) on Medium, the whole server (20) answering the
     notice ≈ 13.8 / 9.0 ms: passes G1 [projected]. High WebGPU at 20 players misses 60 fps, as the measured crowd + 20
     bots already does (17.1–19.3 ms): the cost of 20 player characters, BACKLOG item 9.
   - **G2 (High) keeps WAVE_PLAN6's lines** with town life on: plaza ≤ 12 → ≈ 6.4–7.0 ms, crowd ≤ 14 → ≈ 8.7–9.5 ms.
     New **G5**: no TAA smear on walking townsfolk on High.
5. **Order (§6):** step 0 seams → step 1 the lanes of both items in parallel → checkpoint **X1** (data + town assets +
   sound) → step 2 the dependent lanes → checkpoint **X2** (dressing, lamps, the final town file) → **I-11**
   integration → **LAB-11** bench → **H-11** hunt with 14 lenses → **F-11** fixers → **G-11** final gate → **V-11**
   independent verify → the user's checks.
6. **Never cut** (§7): **the Tiger fix** (the composite with the full saddle transform, its LOD lockstep and the 8 s
   corpse), **the announcements** (appear and defeat banners with sound, one alive with persisted 3–6 h timers), **people
   in the streets** (the VAT crowd on Medium and up); plus the Low guard, the crowd's determinism, no click swallowed,
   the fury and the leash reset, and G1.
7. **What the user must do (§8):** nothing blocks the start. The user looks at the preview sheet and the two spec
   sheets, later judges sounds by ear, and does one party kill with friends.

### 0.1 Where each user request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "shes riding a tiger, the tiger doesnt show up in game ... Fix her" | UNIQUES §2: `MobDef.ride` from characterInfo's `ride` column; the ridden-mob composite on the `saddle` joint with its full transform; LOD lockstep; the 8 s unique corpse | W11-CV, W11-P, W11-G, W11-SV, U-RC |
| "in retail unique monsters are world bosses" | UNIQUES §3.2 spawn rules (11 camps, one alive, 3–6 h, persisted), §3.6 behaviour, §4 balance | W11-SV, U-S, U-BAL |
| "she needs announcement upon spawn etc." | UNIQUES §3.3: `uniqueNotice`, the one `NoticeBanner` queue with a unique style, a chat line, the retail alarm and event-complete sounds; "etc." = loot, EXP, Berserk, map, GM, the quest hook (§3.4–§3.10) | W11-P, U-S, U-H, U-Q |
| "make Jangan town ... beautiful" | TOWN_LIFE §7: night light pools, dressing, crack grass, decals, the pond, the gated B2 batch | TL-B, TL-M |
| "a living town ... it looks dead right now, static, and empty" | TOWN_LIFE §3 people, §4 animals, §5 motion, §6 sound, §3.5 day and night | TL-V, TL-R, TL-C, TL-M, TL-S, TL-A2 |
| "also jumping needs to be a bit higher" | §0.3: the polish pass's P-JUMP (lift 0.6 m, pelvis apex 1.31 → 1.61 m) | (polish); MV-H only if the user asks again |
| standing goal "at least 60 fps" | §5: G1 with the 20-player plaza and the town; G2; G5 | LAB-11, G-11 |

### 0.2 "Grass to the horizon": what the polish pass delivered [confirmed: docs/GRASS_FAR.md, `git status`, file times]

The user's top complaint ("I only see a portion of the grass loaded ... it cuts off") is **built and measured** by the
polish lane P-GRASS-FAR, **uncommitted** (its files were last written 07:47–08:49 today; not at HEAD):

| Delivered | Evidence |
|---|---|
| Ring A, the near field: unchanged (14 / 32 / 58 m Medium, 20 / 46 / 82 m High) | GRASS_FAR §1 |
| **Ring B, the meadow ring** (`grass/ring.ts`, `ring-window.ts`, `ring-shaders.ts`): three-blade GPU tufts on 16 m cells in three nested sub-rings, flower dots, out to ≈ 255 m (Medium) / ≈ 310 m (High), 3 draws, an 832 m ring window at 2 m filled in ≤ 0.6 ms slices | GRASS_FAR §2–§3; the new files exist |
| **Ring C, the far carpet** (`grass/chunks.ts`, `tint.ts`): tuft pattern, shaded roots under ring B, the wind sheen | GRASS_FAR §4 |
| No edge: ring A's blades and ring B's tufts sum to 1 across the band; 10 m band noise on all three hand-overs | `grass-far.test.ts` (19 tests) |
| Cost: +3 draws, +0.07 ms GPU, ≈ +1.4 MB textures, CPU within noise; **G1 holds** under a busy machine (worst Medium p95 11.3 ms WebGPU, 9.1 WebGL2) | GRASS_FAR §5 (interleaved A/B, GPU lock) |
| Low, Off, Classic and **Grass: Low (the Mac / iGPU default)** unchanged | GRASS_FAR §1, the Low guard tests |

**What is not finished**, and becomes lane **GF-R** in this wave (§6.1):

1. **A quiet-machine bench.** The polish bench ran at 70–97 % CPU load (numbers ≈ 2× the gate's); High's plaza and crowd
   (G2) were not re-run with the ring. LAB-11 adds the user's meadow spot (`/tp 114 93`) and re-runs G2 with the ring on.
2. **WebGL2 black blotches on the far terrain** (beyond ≈ 60 m: crop fields, the far road, the hills), present **before**
   the ring too, likely the terrain tile arrays' small mips on WebGL2 [likely: GRASS_FAR §7]. WebGL2 is the fallback, and
   the blotches sit exactly where the user now looks at far grass: GF-R diagnoses and fixes it.
3. **Grass: Low gets no ring** (the Mac and iGPU default) until a friend's Mac is measured. GF-R adds ring B at Low with
   one sub-ring (B1 only, ≤ 150 m) behind a measurement on the dev PC's WebGL2 at Retina-like 0.75 scaling; cut item 18.
4. Not this wave: a blade-scale normal for ring C (it needs a terrain-plugin normal seam; deferred, §11).

The ring's commit is the polish workflow's, not this wave's; wave 11 builds on it (D1).

### 0.3 "Also jumping needs to be a bit higher" [confirmed: `git diff`, docs/MOVEMENT.md §3.2, Dropbox `wave10/jump-higher.gif`]

The polish workflow's **P-JUMP** (2026-10-01) already answers this message: every jump clip now lifts **≈ 0.6 m**
(was 0.2–0.3 m), the standing JUMP's pelvis apex goes **1.31 → 1.61 m** with **700 ms in the air** (was 433 ms), the
clip is 1.37 s, the 1,000 ms cooldown is kept; `content/moves/*/jump*.json` and `work/out/moves/` were regenerated at
07:34 with 0 failed checks. **It is uncommitted** and not at HEAD `f56d175`, so it reaches the user only when the polish
pass is committed and built, and the client reloads.

[decision, D30] Wave 11 does not touch the jump. If the user tries P-JUMP and still finds it low, lane **MV-H** (a
one-number change: `apexRiseM` 0.6 → 0.8 m in MOVEMENT's keying, `pnpm sro moves`, the MV-A checks; ≈ ½ day) is ready
and runs in step 1 without touching any other lane's file (§6.1). Default: P-JUMP's 0.6 m.

---

## 1. Lane ids

| Id | Step | From spec | What |
|---|---|---|---|
| **W11-P** | 0 | UNIQUES U-P + TOWN_LIFE TL-R's shared part | `packages/shared` (protocol, validators, content types, the town file types and validator), the mock, PROTOCOL.md |
| **W11-SV** | 0 | UNIQUES U-SEAM-S (with the fact-check's F20 additions) | Every `apps/server` seam |
| **W11-S** | 0 | TOWN_LIFE TL-0 (world-render half) + the post and water hooks | Every `packages/world-render` seam |
| **W11-G** | 0 | UNIQUES U-SEAM-C + TOWN_LIFE TL-0 (game half) + the notice dispatch | Every `apps/game` seam |
| **W11-CV** | 0 | UNIQUES U-CV + the converter halves of TL-R, TL-B, TL-M, TL-S, TL-V | `mobs.ts` ride, sound cues and export list, the town hook sites, the `town` verb |
| TL-A2 | 0 → 1 | TOWN_LIFE TL-A2 | Blender-keyed SIT_CHAIR, CARRY, TALK, SWEEP (data work starts at once) |
| TL-K | 0 | TOWN_LIFE TL-K | Census of retail props usable as goods, pots, benches, carts (data only) |
| U-RC | 1 | UNIQUES U-RC | The ridden-mob composite (`world/ride-mob.ts`) |
| U-S | 1 | UNIQUES U-S | The uniques module, `/unique`, `content/uniques.json` |
| U-H | 1 | UNIQUES U-H | The unique notice style, text, sound and chat line |
| U-BAL | 1 → 2 | UNIQUES U-BAL | The balance sim and docs/BALANCE.md |
| TL-V | 1 | TOWN_LIFE TL-V | Dressed variants, atlases, the shared half-float VATs (converter) |
| TL-R | 1 | TOWN_LIFE TL-R | Route graph script, `content/town/jangan.json`, the pure schedule |
| TL-C | 1 | TOWN_LIFE TL-C | The crowd runtime (`town/{crowd, animals, bubbles, props, index}.ts`) and its app feature |
| TL-M | 1 | TOWN_LIFE TL-M | Cloth sway chunk, the cloth reclass, steam and leaf layers, ripples |
| TL-S | 1 | TOWN_LIFE TL-S | Town audio, the seeded synthesis |
| TL-B | 1 (phase 1) → 2 (phase 2) | TOWN_LIFE TL-B | Dressing, lamps, crack grass, decals, the pond; then the B2 batch |
| GF-R | 1 | GRASS_FAR §7 (this plan, §0.2) | Far-grass remainder: WebGL2 far-terrain blotches, the Grass: Low ring, the bench scenes |
| MV-H (standby) | 1 | MOVEMENT §3.2 (this plan, §0.3) | Only if the user asks for a still higher jump |
| U-Q (optional) | 2 | UNIQUES U-Q | Rumour dialog lines and the `uniqueAlive` fact |
| TL-L | 2 | TOWN_LIFE TL-L | Viewer town panel and the LAB-11 town scenes |
| **I-11** | 3 | I-11 of both specs | Integration, re-converts, docs, deploy list |
| **LAB-11** | 3 | LAB-11 (town) + the fight bench (UNIQUES §8.3) + GF-R's scenes | One bench list, one method, one results file |
| **H-11** | 3 | both specs' hunts | One adversarial hunt with 14 lenses (§6.6) |
| **F-11** | 3 | — | Fixers, one per file set (§6.7) |
| **G-11** | 3 | — | The final gate re-bench (§6.8) |
| **V-11** | 3 | — | An independent verify by an agent that built nothing (§6.9) |

**Dropped ids:** U-P, U-CV, U-SEAM-S, U-SEAM-C (→ W11-P, W11-CV, W11-SV, W11-G); TL-0 (→ W11-S and W11-G; its
`settings.ts`, `hud/options.ts`, `screens/world.ts` and `ux-world.ts` parts go to W11-G); the two specs' own I-11
(→ one I-11).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | When wave 11 starts building | both (their fact-checks list the polish tree's files) | The polish workflow edits `three/models.ts` (+5 lines), `stage/host.ts`, `screens/warmup.ts`, `convert-world.ts`, `cli.ts`, `gamedata.ts` and the grass, uncommitted [confirmed: `git status`; UNIQUES' risk table predates the `models.ts` change] | **Step 0 starts after the polish pass is committed** [decision]: every seam agent re-reads its files at that commit (WAVE_PLAN6's rule). The scratch and data lanes (TL-A2, TL-K, U-BAL's sim) start at once. Reason: no rebase of seams onto an uncommitted tree. |
| D2 | `packages/world-render/src/world.ts`, `batch/types.ts`, `batch/region-batch.ts`, `batch/merge-core.ts` | TOWN TL-0 (`World.town`, `'town'` in `UNBATCHED_TAGS`, `pivotSize 4` on `+sheen` groups with a per-piece cloth pivot) | Shared world-render modules | **W11-S writes every edit**; afterwards only I-11. `World.town: TownPart \| null` (PBR only, null on Low/Classic, updated after `life`, disposed with the world, re-made by `setRenderMode`); `'town'` appended to `UNBATCHED_TAGS` (beside `'scatter'`, `'life'`, `'ocean'`); the `+sheen` groups take `pivotSize 4` only when a record carries a cloth kind, else byte-for-byte today's merge. Reason: one agent on the batcher's claim, as WAVE_PLAN6 D1–D3. |
| D3 | `pbr/foliage-plugin.ts` | TOWN TL-M (the `SRO_CLOTH_WIND` chunk in the vertex hook) | BT-P owned it in wave 10 | **W11-S adds the define slot with an empty chunk** (strings equal HEAD with it off); **TL-M owns the chunk file `town/cloth-chunk.ts`** and never edits the plugin. Reason: the plugin stays a one-owner file. |
| D4 | `render/post.ts` | TOWN F3 / G5-11 (TAA smears the crowd; reprojection or MSAA ×4 while town life draws) | Post is shared render code with a known WebGPU trap (D30: reprojection broke thin instances) | **W11-S adds one hook**, `RenderPost.setTemporalOverride(owner, mode: 'none' \| 'msaa4')`, and the previous-matrix buffer path stays TL-C's to try inside its own meshes. TL-C calls the hook only if its reprojection attempt fails G5. Reason: the crowd cannot reach into post's internals, and the fallback is reversible. |
| D5 | `water.ts` | TOWN TL-M (ripples from fish, ducks, the fountain) and TL-B (a town pond profile) | Two lanes, one file | **W11-S adds both seams** (`WaterRenderer.setRipplePoints(points)` and a per-region `waterProfile` lookup with a `'town'` profile slot); **TL-M owns the ripple point source, TL-B fills the profile's numbers as data** (`content/town/jangan-dressing.json` `pond`). Nobody edits `water.ts` after W11-S. Reason: one owner, and the pond may be a bug first (§2.3 D21). |
| D6 | `packages/shared` | UNIQUES U-P (`uniqueNotice`, `MobDef.ride`, `UniqueDef`), TOWN TL-R (`packages/shared/src/town.ts`, `validateTownFile`) | Two items, one package, one `index.ts` | **W11-P writes both completely** (§3), including `index.ts` exports. Afterwards **TL-R owns `town.ts`** (it may refine the validator with the content), **U-S owns nothing in shared** (its content shape is fixed in §3.4). Reason: the WAVE_PLAN6 W10-P pattern. |
| D7 | `three/models.ts`, `world/entities.ts` | UNIQUES U-SEAM-C (`companion`, `lodLeader`, suppressed self-resume, composite extents through a height hook; the ride load hook; `setYaw` and root scale redirected to the ride) | Touched by the polish pass too (D1) | **W11-G lands all of it** after the polish commit; **U-RC owns `world/ride-mob.ts` only** and never edits the two files. The town does not touch them (VAT lives in world-render). Reason: one owner of the actor class. |
| D8 | `app.ts`, `ui/notice.ts` | UNIQUES U-H (the `uniqueNotice` case next to `notice`; a `kind: 'unique'` style on the one `NoticeBanner` queue) | `app.ts` shows the GM notice on every screen | **W11-G adds the `uniqueNotice` case in `app.ts`**, calling `showUniqueNotice(msg, ctx)` from a stub `hud/unique-notice.ts`; **U-H owns `ui/notice.ts`, `hud/unique-notice.ts` and `i18n/en-unique.ts`**. Reason: `app.ts` stays seam-only this wave. |
| D9 | `screens/world.ts` | UNIQUES U-H (the chat line), TOWN TL-0 (`world.town?.setClock(ctx.serverNow)`, `setThreats`), TOWN Q5 (the town reacts to the appear notice) | Three edits from two items | **W11-G writes all three lines** in one commit: `setClock`, `setThreats` (the same feed as `world.life`), and in the `uniqueNotice` handler `uniqueChatLine(msg)` (U-H's) plus `world.town?.alarm(serverNowS, 60)` (TL-C's). Nobody edits `screens/world.ts` afterwards (I-11 only). Reason: WAVE_PLAN6 D17's rule. |
| D10 | `settings.ts`, `hud/options.ts`, `i18n/en-render.ts`, `i18n/en.ts` | TOWN TL-0 (`graphics.townLife: 'off' \| 'low' \| 'full'`, the Options row, Mac/iGPU default Low), UNIQUES (registers `en-unique.ts`) | Shared normaliser and registry | **W11-G** adds the field, its normalisation (old saves: Full on Medium+, Off on Low; `isAppleGpu`/iGPU → Low), the Graphics row, the strings, and the `en-unique` import in `en.ts` [confirmed: `en.ts` registers the `en-*` files]. Afterwards **TL-C owns the default tuning** in `settings.ts` only. |
| D11 | `world/features/ux-world.ts`, `world/features.ts` | TOWN (the speech cursor over a townsperson, the non-consuming click pick, the DOM bubble pool) | The click path is the game's movement path | **W11-G adds** a `townPick` hook in `ux-world.ts` that runs **after** the entity and item picks and **never consumes the click** (F9), and registers a stub feature `world/features/town.ts`; **TL-C owns `world/features/town.ts`** (bubbles positioned through `layoutPlates`, the click bubble, the alarm hook's caller). Reason: one owner for the click order. |
| D12 | The sound cue table and export list (`packages/convert/src/sound/build.ts`, `tools/export-sound.ts`) | UNIQUES (cues `ui.uniqueAppear` = `snd/ui/alarm_sound.wav`, `ui.uniqueDown` = `snd/ui/eventcomplete.wav`), TOWN TL-S (`env/bell towel 3.wav`, the `cos_horse_*`, `cos_cat_*`, `cos_wolf_01_*`, `cos_donkey_*`, `cos_cow_*` files) | Two lanes add entries to one table | **W11-CV adds every retail entry of both items** in step 0 (data only); **TL-S owns `packages/convert/src/sound/town-synth.ts`** (new) and `apps/game/src/audio/town.ts`; U-H only names the cues. The sound export runs at X1. Reason: one writer of the list. |
| D13 | `packages/convert/src/world/convert-world.ts` | TOWN TL-B (dressing placements before the batcher's inputs), TL-R (copy `town.json` into `world/<world>/`), TL-M (the cloth reclass and per-piece pivots on the batch record), polish (the coast hook, environment overrides) | Four users of one file | **W11-CV adds three hook call sites** after the polish commit, in the order **coast (C9) → environment overrides → town dressing → cloth reclass → static variants → grass palettes**, plus the `town.json` copy in the export writer; afterwards **TL-B owns `world/town/dressing.ts`, TL-M owns `world/town/cloth.ts`, TL-R owns `town/build-graph.ts`**, and nobody edits `convert-world.ts` (I-11 only). Reason: dressing must exist before the batcher, static variants and grass masks read placements (WAVE_PLAN6 D6). |
| D14 | `packages/convert/src/cli.ts` | TOWN TL-V (`town` verb: variants, VATs, atlases), TL-R (`town-graph`) | Polish also edits `cli.ts` (+1) | **W11-CV adds `town` and `town-graph` verbs on stub modules**; TL-V and TL-R fill their modules. |
| D15 | The ambient rows for new lamps (`cj_field_lamp` ×4 and the new lantern posts) | TOWN §7.1 (a light is an `ambient.json` row of a placed model, F4) | Which converter file writes them | **TL-B writes them through a data table** (`content/town/jangan-dressing.json` `lamps`) that the converter's model-fx ambient step reads [likely file: `packages/convert/src/fx/model-fx.ts`]; W11-CV adds the read of that table. `night-lights.ts` is not edited. Reason: lamps are data. |
| D16 | Server files | UNIQUES (`spawner.ts`, `config.ts`, `db.ts`, `world.ts`, `gameplay.ts`, `mob-skills.ts`) | Only one item touches the server | **W11-SV lands every seam**; **U-S owns `uniques.ts`, the `/unique` row in `gm.ts` and `content/uniques.json`** afterwards. The town adds nothing to the server [confirmed: TOWN §2.1 option C]. |
| D17 | `stage/host.ts` / `stage/stages.ts` | TOWN §12.4 (the stage keeps townsfolk off the steps: a `noFolk` circle) | The polish pass edited `stage/host.ts` | **W11-G passes `noFolk`** (one option on `World.town.configure`, which W11-S defines) after the polish commit; SCR-R's files are otherwise untouched. |
| D18 | Content files | UNIQUES (`content/uniques.json`, optional dialog lines in `content/quests/jangan.json`), TOWN (graph, places, folk, lines, dressing in one `content/town/jangan.json`) | TL-R and TL-B would share one town file | **Split the town content in two** [decision]: `content/town/jangan.json` (graph, places, folk, schedules, lines: **TL-R**) and `content/town/jangan-dressing.json` (props, banners, lamps, decals, the pond profile, crack-grass bands: **TL-B**), both validated by `validateTownFile` (two `kind`s). `content/uniques.json`: **U-S**; `content/quests/jangan.json`: **U-Q** only. Reason: no two lanes in one file. |

### 2.2 State ownership (one source of truth each)

| State or module | Produced by | Consumed by | Owner lane |
|---|---|---|---|
| Which mob rides what (`MobDef.ride {model, joint: 'saddle'}`) | the converter from characterInfo's `ride` column | `EntityView.load`, U-RC | **W11-CV** (data) |
| The composite pose (seat, mirrored clips, LOD decision, extents) | `world/ride-mob.ts` on the `companion`/`lodLeader` seams | the label, pick, culling, shadows | **U-RC** |
| Unique state (phase, due time, camp, spawns, last killer) | `apps/server/src/uniques.ts`, SQLite table `uniques` | `/unique`, the notices, the quest fact | **U-S** |
| Unique tuning, loot, timers, corpse time | `content/uniques.json` | U-S, the corpse sweep (`corpseMs`) | **U-S** |
| The kill's owner group (before `m.damage.clear()`) | `gameplay.ts` kill path | U-S (the defeat notice) | **W11-SV** writes; frozen afterwards |
| Which nests the Spawner may use | `Spawner.refusal` (refuses `uniqueGroup` nests while `UNIQUES=on`) | the Spawner, `updateNest`, `content reload nests` | **W11-SV** |
| The notice banner queue (GM and unique) | `ui/notice.ts` | `app.ts` | **U-H** |
| The townsfolk's state | the pure `town/schedule.ts` `stateAt(agent, nowS, solarT)` from `town.json` + seeds | the crowd, the bubbles, the bed's count (`populationNear`, also on Low) | **TL-R** |
| The crowd's draw (VAT managers, thin-instance buffers, the cap, the time base) | `town/crowd.ts`, `animals.ts` | `World.town` | **TL-C** |
| Dressed variants and VATs | `packages/convert/src/town/{variants, vat, atlas}.ts` | TL-C | **TL-V** |
| Placements in town (retail + dressing) | the converter (C9 → environment → dressing) | the batcher, the grass masks, night lights (via ambient rows) | **TL-B** (dressing data), **W11-CV** (hook order) |
| Cloth sway (kind, pivot, phase) | the converter's cloth reclass + the `SRO_CLOTH_WIND` chunk | the `+sheen` groups | **TL-M** |
| Town sound (bed gain, bell, one-shots) | `audio/town.ts` | the ambient bus | **TL-S** |
| The `townLife` setting | `settings.ts` | `graphics.ts`, TL-C | **W11-G** writes; **TL-C** tunes defaults |
| The far grass ring | `grass/**` (polish) | — | **polish** (built); **GF-R** for the Grass: Low ring only |

### 2.3 Cross-item conflicts in behaviour

| # | Topic | Problem | Decision |
|---|---|---|---|
| D19 | The town reacts to the boss announcement (TOWN Q5) | It needs the unique message on the client, and must not leak anything | **Yes, cosmetic** [decision]: on `uniqueNotice` `appeared`, `World.town.alarm(nowS, 60)` overrides the schedule for 60 s (walkers hurry 1.3× to the nearest door or eave, vendors stay, guard pairs walk to the south gate). No late replay (UNIQUES has none), so a friend who logs in during that minute sees the normal schedule, and two clients differ by their message latency (≈ 0.1 m): accepted. Reason: it ties the two items together for free. Cut item 7. |
| D20 | Where the boss and the town meet in the frame | Could a fight and the crowd stack in one view? | **No** [confirmed: the 11 camps are ≥ 1 km from town, UNIQUES §10]. The two budgets never add: the G1 scenes are the plaza (town) and a camp (fight), separately. |
| D21 | The east pond "reads as dry" (TOWN §1.6) | A possible wave-10 regression, found by the town survey | **TL-B checks it in the game first** (day 1 of its lane): if the plane does not draw, it is a bug for **F-11** with an H-11 lens (lens 12); if it draws but reads dry, it is a look for TL-B's pond profile. Reason: do not paint over a bug. |
| D22 | Town life and the GM notice banner | Townsfolk bubbles and the top-centre banner | Bubbles are world-anchored (≤ 3, `layoutPlates`), the banner is screen-fixed at the top centre; no overlap rule needed [likely]; H-11 lens 9 checks it. |
| D23 | Low (Classic) | Both items | **Low stays as today for the town** (no `World.town`; retail placements only; the bed and the bell still play, their count from the pure schedule). **The Tiger fix and the notices are on Low too** (the composite is 3 meshes; UNIQUES §2.3 step 7). The Low guard tests must stay green; the composite gets its own Low test (§6.4). |
| D24 | Animation LOD for the crowd vs the composite | Two different paths | The crowd has no CPU animation (VAT); the composite uses `lodLeader` (D-U22). No shared code. |
| D25 | Shader warm-up | The crowd's VAT effects (TOWN §8.1) and the tiger's first-sight compile (UNIQUES §6.2) | The crowd compiles at world load through `warmup-hooks.ts` (TL-C registers); the tiger loads in the same `load()` as the rider (one hitch at first sight, not two). Neither touches `screens/warmup.ts` (the polish pass's). |
| D26 | First-run preset and the new Options row | — | Unchanged first run (Medium everywhere); `Town life: Full` on Medium+, `Low` on Macs and iGPUs, `Off` on Low. |

### 2.4 Data, content, tools and delivery

| # | Topic | Decision |
|---|---|---|
| D27 | Re-converts | Two lead checkpoints when no lane writes `work/out/`: **X1** after W11-CV, TL-V's first variants, TL-R's first graph and TL-M's cloth reclass: `pnpm sro convert` data step (mobs.json `ride`), the `town` verb (variants, VATs, atlases), the sound export (the two unique wavs, the bell, the cos files, the synthesized loops when TL-S lands), `convert` + `optimize-out --only world/jangan-fields/` (cloth pivots, the town file copy). **X2** after TL-B phase 1 (dressing, lamps' ambient rows, crack-grass bands) and the TL-R tuning pass: world re-convert + optimize. The B2 batch runs on the GPU queue after X2 only if its gate passes. |
| D28 | The GPU queue | Every GPU timing takes `work/tools/gpu.lock` (mkdir; owner file "label time"; only the creator removes it). Priority: LAB-11 / G-11 timings > TL-V bakes (if GPU-assisted) > B2 > anything else. Blender (TL-A2, headless) needs no lock. |
| D29 | Downloads and uploads | **None.** The tiger, the bodies, garments, guard, animals, sounds and effects are retail files the converter already reads; the new clips are hand-keyed in Blender 5.2; the town sounds are synthesized offline by a seeded script [confirmed: both specs' needs lists]. A CC0 sound pack stays an open question defaulting to no (§10). |
| D30 | The jump | Not touched this wave; P-JUMP (polish) ships; MV-H on standby (§0.3). |
| D31 | What players download | the tiger glb (86 KB brotli, on first sight) [confirmed]; the town assets on Medium ≈ 10–15 MB (VATs ≈ 4 MB, 10 atlases, geometry, sounds ≈ 0.5 MB), less if TL-V's 1024 × 512 atlases work [projected: TOWN §9.1]; the re-converted town regions (dressing, cloth pivots); High + ≈ 3–5 MB. Low downloads only the bell and the bed (≈ 0.4 MB). |
| D32 | Stale clients after the deploy | Server and client deploy together with a "reload the page" note; an old client warns and drops `uniqueNotice` (`net/wire.ts` drops unknown frames [confirmed: WAVE_PLAN6 §3.2]); a new client against an old server simply never sees one. |
| D33 | New 3D models | Only TL-B's low-poly props (≤ 300 triangles each, retail-style textures; goods, a crate for CARRY, lantern posts, banners) [decision: no character or creature model]. |

### 2.5 Numbers and config (consolidated)

| What | Value | Source |
|---|---|---|
| Tiger seat | the ride's `saddle` joint, full world matrix, set in the frame tick on `onBeforeRenderObservable` after `animate()` | UNIQUES §2.3, F6 |
| Composite label / pick | standing height ≈ 3.0 m (test 2.8–3.4), pick radius 2.8 m | UNIQUES F2 |
| Unique corpse | 8 s (`corpseSec`); normal mobs keep `CORPSE_MS` 3 s | UNIQUES D-U21 |
| Unique timers | first spawn 10–30 min; respawn 180–360 min; restart while waiting keeps the due time (overdue → 1–2 min); restart while alive → 1–2 min at a new camp | UNIQUES §3.2 |
| Tiger Girl tuning | `hpMul` 0.08 (47,898 HP), attack ×1, EXP ×1 (451,200); leash 50 m; summons 2 normal tigers per wave at 80/60/40 %, ≤ 4 alive; enrage ≤ 20 % HP ×1.25; fury after 600 s ×2 | UNIQUES §3.6, §4 |
| Unique loot | 3 × 2,000–4,000 gold; 3 degree-3 items with `reqLevel` ≤ `LEVEL_CAP`, +0/+1/+2/+3 at 55/25/15/5 %; 2 elixirs; 50 % Lucky Powder (3rd) ×1–2; 10 + 10 Large potions; 20 % Seal of Star | UNIQUES §3.4 |
| Town counts | Low 0 / Medium 60 / High 100 / Ultra 140; range 60 / 90 / 120 m; minus 3 per player in range beyond 5, ≥ 15; VAT animals halve beyond 10 players; `Town life: Low` halves | TOWN §8.1–§8.2 |
| Town draws | Medium ≈ 16 (10 people variants + 2 guards + 3 animal kinds + blobs) + ≤ 2 cloth groups | TOWN §9.1 |
| VAT | one half-float VAT per skeleton (man, woman), ≈ 2.0–2.2 MB each, 30 fps (VENDOR01 15 fps); `manager.time = nowS − t0`, re-based hourly | TOWN §2.2, §3.2 |
| Day | 120-min game day, night speed-up 0.4 (a game hour ≈ 5 real minutes); the bell on every game hour | TOWN §2.2, §6 |
| Night lights | container 8 / 32 / 64 (Medium / High / Ultra); the four `cj_field_lamp` rows first, then 16 lantern posts; ≤ 4 moving lights, only when `addDynamicLight` returns true | TOWN §7.1 |
| Ambient fx budget | ≤ 30 of the 40 emitters within 60 m of the plaza | TOWN §9.2 |
| Grass ring (built) | Medium to ≈ 255 m, High ≈ 310 m; Grass: Low none (GF-R: B1 only ≤ 150 m, cut 18) | GRASS_FAR §1 |

---

## 3. Protocol and migration (protocol v1, additive; landed by W11-P and W11-SV)

### 3.1 `packages/shared/src/protocol.ts`

```ts
// ServerMessage (world sockets only; never in the lobby or on the character screens)
| { t: 'uniqueNotice'; event: 'appeared' | 'defeated'; mob: string; name: string;
    area?: string;      // GameData.zoneName at the camp, printed as is ("North-Tiger Mt.")
    by?: string;        // defeated only: the loot-owner group's top-damage member
    party?: boolean }   // defeated only: that group is a party → "Mei's party has defeated Tiger Girl!"
```

- **Collision check** [confirmed: UNIQUES §5.1 and its fact-check grep of `protocol.ts`]: no `uniqueNotice` in either
  union. The town adds **no message**: it reads the world clock every client already has (`worldEnter.world.clock`,
  `worldClock`, `ServerClock`) [confirmed: TOWN §2.1].
- **Validators** (`validate.ts`): `event` in the two values; `mob`, `name` non-empty strings; `area`, `by` optional
  strings; `party` optional boolean; `by`/`party` rejected on `appeared`.
- **No client request**, no new fail reason, no rate-limit row. `GAMEPLAY_REQUESTS` unchanged.
- **Mock** (`apps/game/src/net/mock.ts` + `net/mock/*`): `/unique spawn` in the mock chat emits an `appeared` and, 20 s
  later, a `defeated` with `party: true`, so U-H and TL-C's alarm run before U-S lands.
- **docs/PROTOCOL.md** gets a "Unique notices" subsection in §11.

### 3.2 Content types (`packages/shared/src/content.ts`, `content-check.ts`, new `town.ts`)

- `MobDef.ride?: { model: ModelRef; joint: string }`: a sibling of `championModel`; `ModelRef` untouched (UNIQUES F7).
  Check: `joint` non-empty; the model's `glb` path under `/out/`.
- `UniqueDef` and the `uniques.json` file (UNIQUES §5.3): `mob`, `world`, `camps: 'uniqueGroup' | number[]`,
  `respawnMin`, `firstSpawnMin`, `restartSpawnMin` (pairs, min ≤ max), `tuning {hpMul, attackMul, expMul}`, `summons
  {on, perWave, maxAlive, variants}`, `enrage {hpPct, damageMul}`, `fury {afterSec, damageMul}`, `corpseSec`,
  `announce {appear, defeat, roarRadiusM}`, `drops` (a table id in `dropTables`). The summon bands are **not** in the
  file (the rows' own `aiChance` 80/60/40). Server start fails on an unknown mob, no camps or a bad range.
- `town.ts`: `TownFile` (kind `'town'`: `graph {nodes, edges}`, `places`, `folk`, `schedule`, `lines`) and
  `TownDressingFile` (kind `'townDressing'`: `props`, `banners`, `lamps`, `decals`, `crackBands`, `pond`), with
  `validateTownFile(json)` for both. Nav checks are the build script's, not the validator's.

### 3.3 Migration 10 (`apps/server/src/db.ts`; W11-SV)

```sql
CREATE TABLE uniques (
  code TEXT PRIMARY KEY,              -- MOB_CH_TIGERWOMAN
  phase TEXT NOT NULL,                -- 'waiting' | 'alive'
  due_at INTEGER NOT NULL DEFAULT 0,  -- ms epoch of the next spawn while waiting
  camp INTEGER,                       -- nest id of the current or last camp
  spawns INTEGER NOT NULL DEFAULT 0,
  last_killer TEXT,
  last_killed_at INTEGER
);
```

- **Number: 10** [confirmed: 9 today, UNIQUES F1]. If another change lands a migration first, I-11 renumbers (the
  test asserts `SCHEMA_VERSION` = the list length and that a 9-version DB migrates to the new head).
- Written on spawn, death and GM changes only (a few rows per day). No other table or column this wave
  [confirmed: the town has no server state].
- **Backup:** the deploy's DB backup step runs before the migration (DEPLOY.md); a downgrade is not supported (as for
  every migration).

### 3.4 Config, GM, deploy

- **Server config:** `UNIQUES` = `on` (default) | `off` (off = today's Spawner behaviour, the unique groups spawn as
  plain mobs). No other new key; `MOB_SUMMONS` stays 0 globally (uniques use their own summon switch).
- **GM:** `/unique list | spawn <name|code> [here | camp <id>] | kill <name> | despawn <name> | timer <name>
  <min|now|clear> | quiet <on|off>`, every use in `gm_audit` [confirmed: the table exists]. `/unique quiet` is a
  per-session server flag (the server skips that GM's socket), so no client code.
- **Deploy order:** server and client together (D32), after the DB backup; the re-converted data (mobs.json, the sound
  export, the town assets, the jangan-fields regions) ship with the client.

---

## 4. Seams (step 0; five agents; every edit additive; the Low guard stays green)

All five start from the polish commit (D1) and re-read every file they touch.

### 4.1 W11-P: `packages/shared` + the mock (one agent; effort S)

§3.1 and §3.2 in full: `protocol.ts`, `validate.ts`, `content.ts` (`MobDef.ride`, `UniqueDef`), `content-check.ts`,
new `town.ts`, `index.ts` exports; `apps/game/src/net/mock.ts` (+ `net/mock/*`) emitting `uniqueNotice`; PROTOCOL.md.
**Tests:** `packages/shared/test/unique-notice.test.ts` (validator accepts both events; rejects `by` on `appeared`,
an empty `mob`, a non-boolean `party`); `content-ride.test.ts` (an old `mobs.json` without `ride` validates; a ride with
an empty joint fails); `town-file.test.ts` (both kinds; unknown place kind, an edge to a missing node, a dangling seat
fail).

### 4.2 W11-SV: `apps/server` (one agent; effort M)

UNIQUES §8.1's U-SEAM-S with the fact-check's F18/F20 additions:

- `spawner.ts`: the unique-group refusal **inside `Spawner.refusal`** (so `updateNest`, `/nest` and `content reload
  nests` honour it) when `UNIQUES=on`.
- `config.ts`: `UNIQUES` on/off.
- `db.ts`: migration 10 (§3.3).
- `world.ts`: `Mob.damageMul` (default 1), `Mob.corpseMs?`.
- `gameplay.ts`: register the module slot (`uniques` may be null); the kill path gains (a) a per-mob drop-table
  override hook, (b) drops carrying a `plus` (hard-coded 0 today [confirmed: UNIQUES §1]), (c) the **loot-owner group
  handed to the modules before `m.damage.clear()`** (`mobDied(m, now, credit, owner)`), (d) the corpse sweep reading
  `m.corpseMs ?? CORPSE_MS`; `createMob` already takes `tuning` [confirmed].
- `mob-skills.ts`: a per-mob summon policy hook (on, per-wave clip, cap, variants) and `damageMul` applied where a
  row's percent is scaled (next to `MOB_DAMAGE_RATE`); every mob swing already passes `mobSkills.swing` [confirmed].
- A no-op `uniques.ts` stub registered (U-S fills it).

**Tests:** `unique-seams.test.ts`: with `UNIQUES=off` the Spawner spawns Tiger Girl's group exactly as today (a
snapshot of HEAD's behaviour on the real nests); with `on` the Spawner and `updateNest` refuse the 11 nests; migration
10 applies on a 9-version DB copy; a mob with `damageMul` 2 deals ×2 through `mobSkills.swing`; `corpseMs` 8,000 keeps
the corpse 8 s, a normal mob 3 s; the owner group reaches the hook with the damage map still intact; a drop with
`plus` 2 reaches the ground item. The whole server suite green.

### 4.3 W11-S: `packages/world-render` (one agent; effort M; commits in this order)

1. **The town part:** `World.town: TownPart | null` (PBR only; `null` on Low/Classic; updated after `life`; disposed with
   the world; re-made by `setRenderMode`); `town/types.ts` (`TownPart` with `setClock(fn)`, `setThreats(fn)`,
   `configure({ noFolk, counts })`, `alarm(nowS, sec)`, `setEnabled`, `stats()`); stub `town/index.ts`;
   `LoadWorldOptions.townLife`.
2. **The batch:** `'town'` appended to `batch/types.ts` `UNBATCHED_TAGS`; the `+sheen` groups' `pivotSize 4` with a
   per-piece `(pinY, height, kind, phase)` from a cloth record (`batch/region-batch.ts`, `merge-core.ts`), off unless a
   record carries a cloth kind.
3. **The shader slot:** `SRO_CLOTH_WIND` in the foliage plugin's `CUSTOM_VERTEX_UPDATE_WORLDPOS` family with an empty
   chunk (D3); `material-budgets.test.ts` registration of the cloth group's define set.
4. **Life:** the `float` landing flag (bob only, no peck-hops) for a habitat (TOWN §4).
5. **Post and water:** `RenderPost.setTemporalOverride(owner, mode)` (D4); `WaterRenderer.setRipplePoints` and the
   per-region `waterProfile` slot (D5).

**Tests:** `town-seams.test.ts` (the claim refuses a `'town'` mesh; `World.town` is null on Classic; `setRenderMode`
PBR → Classic → PBR leaves no town mesh; with no cloth record the `+sheen` groups merge byte-for-byte as today; the
chunk snapshot with `SRO_CLOTH_WIND` off equals HEAD's strings in both languages; `setTemporalOverride('x','none')` is a
no-op; ripple points empty = today's water strings); `material-budgets.test.ts`; the Low guard
(`seams-classic`, `release-lowguard`, `abuse-w9f-lowguard`, `abuse-w10r-lowguard`).

### 4.4 W11-G: `apps/game` (one agent; effort M)

- **Actor seams (UNIQUES U-SEAM-C, F4/F5/F20):** in `three/models.ts`, `CharacterActor.companion: CharacterActor |
  null` mirroring `play`, `playAction` (by clip name), `hurt`, `die`, `revive`, `cancelAction`, `stop`, `setOpacity`,
  `setHighlight`, `setEnabled`, `dispose`; the companion's **suppressed self-resume**; `lodLeader` (a follower copies the
  leader's `lodSkip`, `lodNext` and `offscreen`); a height hook so `actor.height` can come from a composite. In
  `world/entities.ts`, the ride load hook (`catalog.mob(code).ride` → `loadRide` from `ride-mob.ts`, a stub that returns
  null) and `setYaw` / the root scale acting on the ride's root when one exists.
- **Notices:** the `uniqueNotice` case in `app.ts` → `showUniqueNotice` (stub `hud/unique-notice.ts`); `en-unique.ts`
  (empty) registered in `i18n/en.ts`.
- **Town:** in `screens/world.ts`: `world.town?.setClock(() => ctx.serverNow() / 1000)`, `world.town?.setThreats(...)`
  (the life feed), and the `uniqueNotice` handler's `uniqueChatLine(msg)` + `world.town?.alarm(...)` (D9); the `townPick`
  hook in `world/features/ux-world.ts` (after the entity and item picks, never consuming the click); a stub
  `world/features/town.ts` registered in `world/features.ts`; `graphics.townLife` in `settings.ts` with normalisation and
  the Mac/iGPU default, the Graphics row in `hud/options.ts`, strings in `i18n/en-render.ts`, the call in
  `world/graphics.ts`; `noFolk` passed by `stage/host.ts` (D17).

**Tests:** `seams-ride.test.ts` (no ride → the actor's node tree equals today's snapshot; a companion receives every
mirrored call; the companion never restarts its own base after an action; `setYaw` on a composite turns the ride's
root only); `settings.test.ts` additions (defaults per preset, Mac/iGPU Low, old saves); a click on the ground with a
stub town pick still yields the move intent; the mock's `uniqueNotice` reaches the stub; the whole `apps/game` suite.

### 4.5 W11-CV: the converter (one agent; effort S–M)

- `packages/convert/src/data/mobs.ts`: `ride` from characterInfo when the ride's skeleton has a `saddle` joint, else a
  warning and no field (UNIQUES §2.2); `bluetiger.bsr` stays on `output.ts`'s extra list.
- The sound cue table and export list (D12): `ui.uniqueAppear`, `ui.uniqueDown`, the bell, the `cos` sets of TOWN §6.
- `convert-world.ts` hook call sites in D13's order; the `town.json` / `town-dressing.json` copy into
  `world/<world>/`; the lamp table read for the ambient rows (D15); the `town` and `town-graph` CLI verbs on stubs (D14).
- Optional (cut 8): the degree-3 `_RARE` item rows (Seal of Star) in `data/items.ts`.

**Tests:** `mobs-ride.test.ts` (a row with `ride` → `MobDef.ride` with `joint: 'saddle'`; a ride without the joint → a
warning and no field; the real export has exactly one ride, Tiger Girl's); the pipeline order (a fixture where C9 drops
a uid and dressing adds one: static variants and grass masks see the dressing, never the dropped uid); a manifest round
trip with no town files (old exports still validate); the sound list resolves every new file in `work/extracted`.

---

## 5. Presets and budgets

### 5.1 What the wave adds per preset

| Preset | Tiger Girl | Notices | Town people and animals | Motion | Town sound | Beauty | Far grass |
|---|---|---|---|---|---|---|---|
| Low (Classic) | the composite (+3 meshes, no shadows) | banner, chat, sound | **none** (the Low guard); retail placements | retail only | the bed (count from the pure schedule) and the bell | the dressing placements and the lamp rows (data both paths read) [decision] | unchanged |
| Medium (default) | +3 draws, +3 shadow casters | as Low | 60 folk in 60 m, 12 animals + pigeons, ≈ 16 draws, blob shadows | cloth sway in `+sheen` groups, smoke, steam, leaves ≤ 150 | all | lanterns (container 8), dressing, crack grass, decals, pond profile | ring B to ≈ 255 m (built) |
| High | as Medium | as Low | 100 folk in 90 m, + ducks, far LOD, cascade-0 casters only if G2 holds (else blobs) | as Medium, leaves ≤ 250 | all | + container 32, B2 if gated | ring B to ≈ 310 m (built) |
| Ultra | as Medium | as Low | 140 folk in 120 m | as High | all | container 64 | as High |

### 5.2 Budgets and honest costs (WAVE_PLAN6 §5.2 format; 1080p)

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome. "Mid" = a CPU ≈ 1.5× slower; "laptop / M1" = CPU × 1.4–2, M1 GPU at
Retina 0.75. Baselines are the **measured wave-10r final gate** (`wave10/budgets.md`, frame p95) [confirmed]. The town's
deltas are the lab's in-page A/B (four Medium WebGPU one-draw runs, +2.0 to +3.4 ms p95) ÷ 1.5 (BATCHING F17's
per-draw factor), with the **undivided** value given where it matters (TOWN F2: the town's cost is script and buffer
work, which F17 did not calibrate). The fight uses the gate's marginal costs per character (a mob ≈ 0.08 ms, a player
≈ 0.41 ms on WebGPU Medium; 0.045 / 0.24 WebGL2; 0.115 / 0.57 WebGPU High) [projected; UNIQUES §6.2,
`work/tmp/w11-plan/budget.py`]. The far grass ring is measured (+0.07 ms GPU, CPU within noise) and added as ≤ 0.1 ms
where it is in view.

**Frame p95 on the dev PC, wave-10r gate (measured) → wave 11 (projected), WebGPU / WebGL2, ms:**

| Preset | Plaza noon, nobody else | **Plaza: 20-mob crowd + 20 jumping players + the town (the new G1 scene)** | Market street, dusk | Tiger fight at a camp: party of 4 / 20 players | Fields night (+ ring) | Pass line |
|---|---|---|---|---|---|---|
| Low | 2.5 / 2.1 → unchanged | 9.4 / 8.5 → unchanged (no town on Low) | unchanged | below Medium; ≈ 9–10 at 20 | 2.8 / 2.1 → unchanged | pass |
| **Medium (default)** | 3.6 / 2.8 → **≈ 4.9–5.9 / ≈ 3.6–4.0** (undivided 5.6–7.0) | 13.4 / 8.5 (repeats 13.0–15.1) → **≈ 13.7–16.2 / ≈ 9.0–9.3** with the cap (15 folk, animals halved); undivided 14.0–16.8; against the final re-bench's 13.4: 14.4–15.1 | ≈ the plaza | **≈ 7.2 / 5.1**; **≈ 13.8 / 9.0** | 5.1 / 3.9 → ≈ 5.2 / 4.0 | **G1 < 16.7: pass, thin (≈ 0.5–3 ms spare) at the 20-player plaza**; LAB-11 decides; cut 20 is the fallback |
| High | 5.2 / 3.3 → ≈ 6.4–7.0 / ≈ 4.0–4.5 (100 folk) | 17.1–19.3 / 12.0 → + ≈ 0.6–1.2 with the cap (55 folk): **misses on WebGPU** (as today: 20 player characters) | as the plaza | ≈ 10.4 / 6.0; **≈ 19.5 / 10.8: misses on WebGPU at 20** | 6.0 / 5.4 (I-10R bench) → + ≤ 0.1 | **G2-11: plaza ≤ 12 → pass; 20-mob crowd ≤ 14 → ≈ 8.7–9.5 pass**; the 20-player scenes are reported, not gated |
| Ultra | 5.7 → ≈ + 1.5–2 (140 folk) | 21.3 → not a target | — | not a default | 7.3 → + ≤ 0.1 | G3 only |

| Preset | Draws added (plaza, main + shadow) | GPU added (dev) | Mid desktop (CPU × 1.5) | Laptop / M1 | VRAM added | Download added |
|---|---|---|---|---|---|---|
| Low | 0 in town; +3 at her camp | ≈ 0 | unchanged | unchanged | ≈ 0.7 MB (tiger, on sight) | ≈ 0.4 MB sounds; 86 KB br tiger on sight |
| Medium | **≈ 16 + ≤ 2 cloth groups** in town; +3 + 3 at the camp | +0.1–0.4 ms (town), ≤ 0.05 (tiger), +0.07 (ring) | plaza +2.0–5.1 ms CPU; **20-player plaza ≈ 20 ms and 20-player fight ≈ 20 ms: miss** (already near the line in wave 10) | plaza +1.9–6.8 ms CPU, halved by their default "Town life: Low"; ≤ 8 players at the fight ≈ 13 ms holds; **20 players miss** | ≈ 19 MB town + 0.7 MB tiger + 1.4 MB ring (built) | ≈ 10–15 MB town (≈ 5–8 with 1024 × 512 atlases) |
| High | ≈ 20 (+ far LOD ≤ 20) + cascade-0 casters ≤ 14 | +0.3–0.5 ms | plaza +1.8–2.7 ms; party of 4 at the fight ≈ 15–16 ms: at the line | not the target | ≈ 25 MB | + ≈ 3–5 MB |
| Ultra | ≈ 24 (+ LOD) | ≈ +0.6 ms | not offered | not offered | ≈ 30 MB | as High |

What the tables mean, honestly:

- **Medium, the default, holds 60 fps everywhere on the dev PC** with both items on. The one thin scene is the one the
  user named: **the plaza with 20 players plus the crowd**. Wave 10 left ≈ 1.6–3.7 ms there; the town takes most of
  it, and the crowd giving way to players (−3 per player beyond 5, ≥ 15) is what keeps it under 16.7 ms. Only the
  corner that stacks the undivided upper bound on wave 10's worst pre-fix repeat (15.1 ms) touches the line (16.8; 16.9
  with the ring's worst case); against the final re-bench (13.4) it is 14.4–15.1 [projected].
- **A world boss gathers players, and players are the cost.** Nothing in the uniques item costs more than ≈ 0.1 ms;
  20 players at her camp cost what 20 players cost anywhere: Medium holds on the dev PC (≈ 13.8 ms), High on WebGPU and
  Medium on a gaming laptop or a base M1 miss. That is BACKLOG item 9 (character LOD, skinning, batching), reported,
  not hidden; this wave cannot lower it.
- **The town's cost is CPU, not GPU** (+0.1–0.4 ms GPU for 60 VAT folk). The frozen-crowd split puts the floor near
  +0.3 ms; TL-C's optimisations (agents in range only, one buffer update per variant, clip buffer only on a change, no
  live skeleton, heights baked in the graph) are what bring the lab's +2–3 ms toward its 1.0 ms budget. **G3-11 (≤ 1.5
  ms) is at risk** until they land [projected, TOWN §11.4].
- **High's TAA smears walkers** (TOWN F3, seen in the prototype's own shot): G5 gates it; MSAA ×4 while town life draws
  is the fallback, and LAB-11 measures its cost.
- **The far grass ring is free in practice** (+3 draws, +0.07 ms GPU, CPU within noise; G1 held under load) [confirmed:
  GRASS_FAR §5]; LAB-11 re-measures it on a quiet machine with G2.
- **Projections rest on two labs and a busy machine.** LAB-11 measures the production bundle on a quiet machine before
  anything ships, and every G1 miss goes to §7.

### 5.3 Per-lane budgets (dev PC, 1080p; the GPU lock for every in-browser timing)

| Lane | Budget |
|---|---|
| U-RC | the composite ≤ 0.1 ms CPU p95 per ridden mob in view, 0 when culled; the ride glb load ≤ 30 ms main thread; no frame > 33 ms when she streams in |
| U-S | ≤ 0.01 ms server CPU per tick; a spawn ≤ 1 ms (place + `createMob`); a DB write ≤ 1 ms, ≤ a few per day |
| U-H | banner show/hide ≤ 0.2 ms; 0 ms per frame otherwise |
| Fight scene (LAB-11) | at a camp, Medium p95 ≤ 9 ms with 4 bots + boss + 4 adds; < 16.7 ms with 20 bots + boss + 4 adds, both backends; High reported |
| TL-C | town CPU ≤ 1.0 ms p95 at the plaza on Medium (60 folk + 12 animals) in the production bundle; GPU ≤ 0.3 ms; draws ≤ variants in range + 3; zero allocations per frame after warm-up; out-of-range agents ≤ 0.02 ms per 100; no shader compile when the first townsperson enters range |
| TL-R | `stateAt` for 300 agents ≤ 0.05 ms per frame; `town.json` ≤ 200 KB |
| TL-V | per variant ≤ 3,000 triangles and one atlas ≤ 1024²; each VAT ≤ 2.5 MB half float; a VAT frame within 1 mm of the skinned pose at float32, 3 mm after half-float quantisation |
| TL-M | cloth sway ≤ +0.05 ms GPU at the plaza; 0 draws where a `+sheen` group exists, ≤ +2 in view at the plaza; puffs + leaves ≤ 0.1 ms CPU, ≤ 2 draws |
| TL-S | ≤ 0.05 ms main thread per frame; the bed as its own loop voice; the bell and one-shots inside the ambient bus's 5 one-shots |
| TL-B | dressing ≤ +4 draws per region, ≤ +0.2 ms CPU at the plaza; ≤ 30 of 40 ambient-fx emitters within 60 m; B2 within +60 MiB VRAM and ≤ +0.3 ms p95 at the plaza |
| Town life together (G3-11) | ≤ 1.5 ms CPU p95 and ≤ 0.5 ms GPU on Medium at the plaza |
| GF-R | the Grass: Low ring ≤ +0.05 ms GPU and ≤ 1 draw on WebGL2 at 0.75 scaling; the blotch fix changes no WebGPU pixel and no Medium WebGL2 p95 by > 0.2 ms |
| MV-H (standby) | the MV-A checks; 0 runtime cost change |

### 5.4 LAB-11 method

The wave-10r final gate's method: the production bundle on a private `vite preview` (a free port, stopped after), a
private server on a **temp copy** of `work/server/game.db` (or a fresh data folder), 1920 × 1080, hardware scaling 1, a
60 Hz timer pump (the pane is hidden), 400 uncapped frames after streaming idles and no shader compiled for 3 s,
`prof.js` once per page, WebGPU `uncapturederror` hooked, the GPU lock held, **a quiet machine** (no other agent's build
or test running: the polish bench's 2× noise must not repeat). Scenes:

1. plaza noon, nobody (town on / off A/B);
2. **plaza noon, 20-mob crowd + 20 jumping bots + the town** (the G1 scene; 4 repeats);
3. plaza night (lanterns), the market street at dusk (lantern carriers), the south gate during the 60 s alarm;
4. the Tiger fight at camp 5906 and at a Bandit's Mountain camp: 4 bots + boss + 4 adds, then 20 bots;
5. the user's meadow spot `/tp 114 93` (ring on), fields night;
6. the stage select and create (townsfolk behind, none on the steps);
7. presets: Medium on both backends first, then High (WebGPU, WebGL2) and Ultra (WebGPU); `?gpuLimits=default` once.

One results file: `work/tmp/w11-lab/budgets.md`, copied to Dropbox `wave11/budgets.md`.

### 5.5 The gates (the 60 fps rule)

- **G1:** Medium p95 < 16.7 ms on both backends in every LAB-11 scene **including the plaza with 20 players plus the
  crowd** and the 20-bot fight, every feature on.
- **G2:** High WebGPU ≤ 12 ms at the plaza and ≤ 14 ms in the 20-mob crowd, town life and the ring on; WebGL2 Medium
  and High ≤ 8 ms at the plaza (WAVE_PLAN6's lines, TOWN F13).
- **G3:** no scene slower than its wave-10r gate number by more than what this plan projects; **G3-11**: town life
  ≤ 1.5 ms CPU p95 and ≤ 0.5 ms GPU on Medium at the plaza.
- **G4:** component gates: the Low guard; `material-budgets.test.ts` (≤ 16 WebGL2 units, ≤ 15 varyings +
  `front_facing`, ≤ 256 layers); 0 WebGPU validation errors; no GLSL on WebGPU; the crowd's draws ≤ variants in range
  + 2; the tiger ≤ +3 draws.
- **G5:** on High, a still camera at the plaza shows no trail or transparency on a walking townsperson (a shot pair
  0.5 s apart at 200 %), and no compile when the first townsperson enters range.

A feature that breaks G1 on a preset ships **off** on that preset or is cut (§7). A G2 or G5 miss blocks High's town
life (it falls back to Medium's counts, blobs and the MSAA path) but not the release; the numbers go to the user.

---

## 6. Steps and lanes

### 6.0 Step order and concurrency

```
(now)    polish pass commits (its own workflow)                 | TL-A2 Blender keying, TL-K census, U-BAL sim: start at once (scratch/data)
step 0:  W11-P (shared) | W11-SV (server) | W11-S (world-render) | W11-G (game) | W11-CV (converter)      -- all from the polish commit
step 1:  uniques: U-S (after W11-P, W11-SV) | U-RC (after W11-G, W11-CV) | U-H (after W11-P, W11-G) | U-BAL
         town:    TL-V (after W11-CV) | TL-R (after W11-P, W11-CV) | TL-C (after W11-S, W11-G; on stub assets until X1)
                  | TL-M (after W11-S, W11-CV) | TL-S (after W11-CV) | TL-B phase 1 (after W11-CV; pond check first)
         grass:   GF-R
         jump:    MV-H only if the user asks
         ── checkpoint X1: data step (mobs.json ride), town verb (variants, VATs, atlases), sound export, world re-convert ──
step 2:  TL-B phase 2 (lamps, crack grass, decals, pond profile) | TL-L (viewer panel, LAB-11 scenes) | U-Q (optional)
         TL-R tuning pass in the lab | TL-A2 clips into the VAT (TL-V re-bake)
         ── checkpoint X2: world re-convert with the final dressing and the final town file ──
step 3:  I-11 (merge, §6.3) → LAB-11 (§5.4) → TL-B's B2 on the GPU queue (only if its gate passes) → H-11 (§6.6)
         → F-11 fixers (§6.7) → G-11 final gate (§6.8) → V-11 independent verify (§6.9) → the user's checks (§8)
```

### 6.1 The lanes

Effort: **S** ≈ one agent session (½ day), **M** ≈ 1–2 sessions, **L** ≈ 3+ sessions.

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **U-RC** ridden mob | `apps/game/src/world/ride-mob.ts` (new) | W11-G's `companion`, `lodLeader`, height hook, ride load hook; W11-CV's `MobDef.ride` | NullEngine on the real glbs (UNIQUES §2.4): pelvis within 0.15 m of the saddle after `play('RUN')`; the rider's root rotation = the saddle's world rotation within 1e-4; STUN plays STAND1 on the tiger; ATTACK2 leaves the tiger holding its last frame 3,333 → 4,000 ms and both resume together; `setYaw(1)` turns only the ride's root; 300 far frames with LOD on skip the same frames; `dispose` disposes both; label height 2.8–3.4 m; the Low (Classic) path builds the composite | in game: `/unique spawn tiger here`, walk round her; run, attack, die (thrown beside the tiger before the fade) | M |
| **U-S** uniques module | `apps/server/src/uniques.ts` (new), the `/unique` row in `gm.ts`, `content/uniques.json` (new) | W11-P types; W11-SV seams | UNIQUES §8.2's full list (windows, restarts in both phases, one alive, the camp roll with unplaceable and disabled camps skipped, notices solo / party / the owner-group case / GM silent / generic `/kill` noticed by the tick, leash reset, enrage once, fury at 600 s with a fake clock, the summon clip, the drop override with every gear `reqLevel` ≤ `LEVEL_CAP` and plus levels on the ground, corpse 8 s, `/unique` + audit rows, `UNIQUES=off` = today, `/nest` never re-attaches a unique nest) | a party kill with friends; the drops | L |
| **U-H** notices | `apps/game/src/ui/notice.ts` (`kind: 'unique'`), `hud/unique-notice.ts`, `i18n/en-unique.ts` | W11-G's dispatch; W11-P's message | text keys (area with a trailing "." printed as is; without an area; the party form); a GM notice and a unique notice queue, never overlap; the cue names `ui.uniqueAppear` / `ui.uniqueDown`; the unique pink `#ff9cf0` and title; nothing in the lobby | the banner + sound on spawn and kill | S |
| **U-BAL** | `work/tmp/balance/sim.ts` (scratch), docs/BALANCE.md §8/§9 | U-S's numbers | the §4.2 time-to-kill table re-derived | — | S |
| **U-Q** (optional) | `content/quests/jangan.json` (two dialog lines), the `uniqueAlive` fact in the quest engine's condition list | U-S | the line shows only while she lives, with the area | talk to Gwakwi while she is up | S |
| **TL-V** crowd assets | `packages/convert/src/town/{variants, vat, atlas}.ts`, the `town` verb's module | W11-CV's verb; the equipment manifest; `@sro/appearance` | `town-vat.test.ts` (VAT frame = skinned pose within 1 mm float32 / 3 mm half float; one mesh + one material per variant; joints remapped by name; actor materials with the retail emissive zeroed) | the variants sheet (all outfits, three angles) | L |
| **TL-A2** new clips | `packages/convert/tools/blender/town/key_town.py`, `content/moves/<skel>/{sit_chair, carry, talk, sweep}.json` | `blender.ts`, the `moves` verb | the MV-A checks (control ≤ 0.1°, contacts ≤ 1 mm, loops close) | the clip GIFs | M |
| **TL-K** census | `work/tmp/town-life/props-census.*` (data) | — | — | — | S |
| **TL-R** routes and schedule | `packages/convert/src/town/build-graph.ts`, `content/town/jangan.json`, `packages/shared/src/town.ts` (after W11-P), `packages/world-render/src/town/schedule.ts` (pure) | `@sro/nav`; W11-CV's verb and copy | every edge on the navmesh at 0.5 m steps and ≥ 0.4 m from nav edges; `stateAt` deterministic (clocks 80 ms apart → ≤ 0.15 m); appear/leave only at doors; no agent inside a building; the hour curve; seats never double-booked; `populationNear` matches the drawn count; the alarm override returns to the schedule after 60 s | walk the plaza at noon and at night | M |
| **TL-C** crowd runtime | `packages/world-render/src/town/{crowd, animals, bubbles, props, index}.ts`; `apps/game/src/world/features/town.ts`; default tuning in `settings.ts` | W11-S's part, tag, post hook; W11-G's pick, clock, threats, alarm; TL-V assets; TL-R schedule | `town-crowd.test.ts` (draws = variants in range; 0 allocations per frame after warm-up; `isVisible` at count 0; caps per preset and per player count; nothing on Classic; `manager.time` < 3,600 s with a 2026 epoch clock and the drawn clip phase = the schedule's; a click on a walker still moves the player; the pigeons never land within 6 m of a route edge; the alarm sends walkers to doors); 0 WebGPU validation errors in the lab | the plaza at noon: busy, nobody pops in, nobody slides | L |
| **TL-M** motion | `packages/world-render/src/town/{cloth-chunk, fx}.ts` (the `SRO_CLOTH_WIND` chunk, steam/puff and leaf layers), `packages/convert/src/world/town/cloth.ts` (reclass list, per-piece pivots), the ripple point source | W11-S's slot, `+sheen` pivot, `setRipplePoints`; W11-CV's hook | define off = today's strings; budgets registration; no new varying; a flag in a `+sheen` group sways with the region's draw count unchanged; puffs lit, not emissive | banners and awnings sway; calm still breathes; smoke leans downwind | M |
| **TL-S** sound | `apps/game/src/audio/town.ts`, `packages/convert/src/sound/town-synth.ts` (seeded) | W11-CV's list; the pure `populationNear` | `audio-town.test.ts` (bell once per game hour, three strokes at 06 and 18; bed gain monotone in the count; the bed on Low follows the schedule; voice limits) | listen at the plaza, the smith, the stable, at night | M |
| **TL-B** beauty | `content/town/jangan-dressing.json`, `packages/convert/src/world/town/dressing.ts`, new props (`packages/convert/tools/blender/town/props/*.py` + outputs), `packages/world-render/src/town/decals.ts`, the crack-grass bands (data for the existing grass mask path, no `grass/**` edit), the pond profile numbers; phase 2: the scoped B2 batch config (TEXPIPE data) | W11-CV's hook and lamp table; W11-S's water profile slot; TL-K's census | every new placement on ground, off the walkable paths (nav unchanged); the lamp rows give lights at the plaza at night (container 8 on Medium); ≤ 30 of 40 emitters within 60 m | before/after sheet: plaza, market, night; B2 before/after | L |
| **GF-R** far grass remainder | the WebGL2 far-terrain fix (files decided by the diagnosis, outside `grass/**` unless the cause is there; [likely] the terrain tile-array mip path); Grass: Low's B1 ring (`grass/cull.ts` levels row only, after the polish commit) | LAB-11 scenes | a WebGL2 shot of the user's spot without black tiles; Grass: Low ring tests in `grass-far.test.ts`; the Low guard | the far fields on `?engine=webgl` | M |
| **TL-L** viewer + bench | `apps/viewer/src/world/town-panel.ts` (counts, roles, clock scrub, A/B), the LAB-11 town scenes | all town lanes | a toggle rebuilds without leftovers | — | S |
| **MV-H** (standby) | `content/moves/*/jump*.json`, MOVEMENT's keying number | the MV-A pipeline | the MV-A checks | the jump | S |

### 6.2 Seams each lane may not cross

- No lane edits `world.ts`, `batch/*`, `foliage-plugin.ts`, `post.ts`, `water.ts`, `three/models.ts`,
  `world/entities.ts`, `app.ts`, `screens/world.ts`, `ux-world.ts`, `convert-world.ts`, `cli.ts`, `gameplay.ts`,
  `spawner.ts`, `db.ts`, `mob-skills.ts`, `world.ts` (server) after step 0: a lane that needs more asks I-11, which adds
  the seam in its own commit.
- No lane edits the polish pass's files except GF-R's one `grass/cull.ts` row (after the polish commit).

### 6.3 Merge order and checkpoints (I-11)

1. Step 0: W11-P → W11-SV → W11-S → W11-G → W11-CV. Suite + typecheck; record the test count.
2. Uniques: U-H → U-S → U-RC (→ U-Q) (→ U-BAL docs).
3. Town: TL-R → TL-V (X1) → TL-C → TL-M → TL-S → TL-B phase 1 → TL-A2 clips (TL-V re-bake) → TL-B phase 2 (X2) → TL-L.
4. GF-R (independent).
The chains touch disjoint files after step 0 and may interleave; the order inside each chain is fixed. After every
merge: the Low guard, typecheck, `material-budgets.test.ts` if a material or define changed.

### 6.4 Cross-item tests I-11 adds

- A live Low ↔ Medium switch with both items on leaves no town mesh, VAT, bubble, sound loop, composite leftover.
- Two NullEngine worlds with clocks 80 ms apart draw every agent within 0.15 m.
- The stage shows townsfolk behind create, none inside the `noFolk` circle.
- The batcher never claims a `'town'` mesh; dressing placements are in the region batches; a flag sways with the
  region's draw count unchanged.
- `uniqueNotice` `appeared` on a world client: one banner, one chat line, the cue, and `town.alarm` once; on a lobby
  socket: nothing sent.
- The Classic (Low) path builds the tiger composite and shows the notices.
- A unique kill in the town's range does not exist (camps ≥ 1 km): asserted on the camp coordinates so a future camp
  edit trips it (D20).

### 6.5 I-11: integration checklist (the lead)

1. Merge per §6.3; suite, typecheck and the Low guard after each merge.
2. X1 and X2 (D27) when no lane writes `work/out/`; check: only Tiger Girl gets `ride`; the two unique cues and the
   town sounds resolve to encoded files; the town files are in `world/jangan-fields/`.
3. Server on a **temp copy** of `work/server/game.db`: migration 10 applied; `/unique spawn tiger here`, `/unique list`;
   a 4-bot kill (the soak harness): the notices, the DB row, the drops (all wearable at the cap, plus levels);
   restart while waiting (due time kept) and while alive (back in 1–2 min at a new camp); a generic `/kill` starts the
   timer; `UNIQUES=off` restores today's behaviour.
4. Two browser clients (WebGPU and `?engine=webgl`): both see the same townsperson at the same spot; the notice and
   the alarm on both; a click on a walker moves the player.
5. LAB-11 (§5.4); a G1 miss goes to §7 before release; G2/G5 to the user.
6. Before/after shots at the bench spots (noon, dusk, night, rain) and an in-game GIF of Tiger Girl for the user.
7. Docs: PROTOCOL.md (§3), ASSETS.md (town assets, the ride), RENDER.md (town part, cloth, post override), SOUND.md
   (town bus, unique cues), DEPLOY.md (migration 10, the town export, the reload note), BALANCE.md (U-BAL), BACKLOG
   (wave 11 done, §11's deferred list), PLAYTEST.md (§8's checks), each spec's status, GRASS_FAR.md (GF-R's result).
8. Scratch: delete `work/tmp/town-life/lab/` after TL-C/TL-L port it and `work/tmp/uniques/proto/` after U-RC; keep
   every shot the user reviewed.

### 6.6 H-11: the hunt (read-only; findings become tests, then F-11 fixes)

The specs' own risks and fact-check lists stand. H-11 runs these lenses with both items on, each by a separate agent
or pass, and files each finding with a failing test or a reproduction:

1. **The composite apart:** the tiger and the rider drift at clip transitions, at a distance (LOD), after a leash reset,
   a stun, a revive, a GM `/kill`, a teleport; the death cut short; the label above her head.
2. **Unique state:** restart storms; two spawns at once; a camp disabled by `/nest` mid-wait; the DB row vs the live
   mob after a crash; clock jumps.
3. **Announcement abuse and correctness:** the wrong name on the defeat notice (solo vs party damage cases); a notice
   on the lobby or the stage; a notice to a GM with `quiet`; doubled sounds; the area's full stop.
4. **Loot and EXP exploits:** summon-reset farming; unwearable gear; plus levels; owner window; Berserk; the bell
   encounter counted twice for JG_025.
5. **Fury and leash griefing:** tag-and-wait, kiting at 49 m, pulling her toward the level-16 grounds.
6. **Black WebGPU frame / validation:** the town, the composite, the ring, the cloth group in one view; `?gpuLimits=default`.
7. **Low changed** by either item (the Low guard plus a pixel diff of the plaza on Low).
8. **Determinism:** two clients, different RTTs, a reload, a teleport into town, a tab hidden for 10 minutes, the hourly
   time re-base, a 2026 epoch; nobody frozen or jumping.
9. **The click and the HUD:** clicks eaten by the crowd; bubbles over name tags or the banner; the speech cursor; the
   townsfolk on the minimap.
10. **Hitches:** the first townsperson in range, the first sight of the tiger, a region commit with dressing, the ring
    fill, the VAT upload; leaks on world → select → world ×3.
11. **TAA smear and night look:** walkers on High still camera; glowing smoke at night; lamps lighting nothing.
12. **Water and the pond:** the east pond dry (D21); ripples on the wrong plane; the ocean sheet over the town.
13. **Placement errors:** props blocking paths, floating or buried, on the stall spots near the spawn; people inside
    walls or on the fountain's rail.
14. **Sound:** voice limits, the bell at the wrong time, the bed on Low with no town part, the unique cues over music.

### 6.7 F-11: fixers

One fixer per file set (the owning lane's files, or I-11 for seam files), each fix with the test H-11 wrote; no fixer
edits another's files. Fixes that change a frame cost are re-measured on the affected LAB-11 scene before G-11.

### 6.8 G-11: the final gate

A re-bench of every §5.4 scene on the final tree and the final X2 export, on a quiet machine, under the GPU lock;
`work/tmp/w11-lab/budgets.md` updated with "final gate" numbers; G1–G5 judged (§5.5). The suite, typecheck and the Low
guard green. Any G1 miss → §7 cuts, then G-11 again.

### 6.9 V-11: the independent verify

A fresh agent that built nothing in this wave:

- re-reads this plan, both specs and the diff, and checks each never-cut item (§7) is present and each decision of §2
  is implemented as written (file owners respected: `git log --stat` per lane);
- re-runs the suite and typecheck, and re-derives three G-11 cells itself under the GPU lock;
- checks the deploy list (migration 10, the town assets, the sounds, the re-converted regions) against `deploy/`;
- reports [confirmed]/[failed] per item to the lead; nothing ships on a [failed] never-cut item.

---

## 7. Scope-cut order (cut from the top; one list for the wave)

Each item names its spec's cut. Items marked **ask first** are cut only after telling the user.

1. U-Q, the rumour dialog lines (UNIQUES cut 1).
2. Ultra's 140 folk and High's far LOD (TOWN cut 1).
3. `/unique quiet` (UNIQUES cut 2).
4. Falling leaves and petals (TOWN cut 2).
5. Decals (TOWN cut 3).
6. Ducks, the rider on the avenue, children running (TOWN cut 4).
7. The town's reaction to the boss announcement (D19).
8. The Seal of Star drop and the `_RARE` export (a +4 degree-3 item instead) (UNIQUES cut 3).
9. The four new clips (TL-A2): retail clips only (sitters on the rim and steps; porters lead horses) (TOWN cut 5).
10. Synthesized chicken, dog and hammer sounds (TOWN cut 6; the bed, the bell and the retail cos sounds stay).
11. The enrage (UNIQUES cut 4; the fury stays).
12. The roar for players near her camp (UNIQUES cut 5).
13. Lantern strings (TOWN cut 7; the lantern posts stay).
14. The steam layer (TOWN cut 8; the retail smoke stays).
15. Crowd cast shadows on High (TOWN cut 9; blobs everywhere).
16. The B2 town texture batch (TOWN cut 10; High only, then cut).
17. The unique chat line (UNIQUES cut 6; the banner and the sound stay).
18. GF-R's ring on Grass: Low.
19. Summons for uniques (UNIQUES cut 7; `hpMul` rises to 0.10).
20. Medium's crowd 60 → 40 and range 60 → 45 m; if G1 still misses: **no townsfolk drawn on Medium with ≥ 15 players
    in range** (the pigeons, the motion and the sound stay) (TOWN cut 11).
21. **Ask first:** clicking townsfolk for flavour lines; rumours; vendor bubbles (TOWN cut 12).

**Never cut:**

- **The Tiger fix:** the composite on the `saddle` joint with its **full** transform, the mirrored clips, the LOD
  lockstep (`lodLeader`) and the 8 s unique corpse; the tiger on every preset including Low.
- **The announcements:** the appear and defeat banners with their sounds, through the one notice queue; one alive at a
  time from the 11 camps; the 3–6 h window and its persistence across restarts (migration 10); the fury and the leash
  reset; the unique drop table's gold, wearable gear and elixirs.
- **People in the streets:** the VAT crowd on Medium and up (walkers, chatters, sitters, vendors, guards), its
  determinism (the same crowd for every friend, no server state), the pigeons, the town bed and the bell, the night
  light pools; no collision or targeting of townsfolk and no click ever swallowed; the batcher's refusal of `'town'`.
- **Everywhere:** the Low guard; ≤ 16 WebGL2 units; ≤ 15 varyings + `front_facing`; ≤ 256 layers; no GLSL on WebGPU;
  0 WebGPU validation errors; **G1 (Medium at 60 fps, the 20-player plaza included)**; no smeared walkers on High (G5,
  by the MSAA fallback if needed).

---

## 8. What the user must provide or approve

**To start: nothing.** Every tool is installed, nothing is downloaded or uploaded, and every item has a default.

1. **The preview sheet** `work/tmp/w11-preview.png` (Dropbox `wave11/w11-preview.png`): Tiger Girl on her tiger, the
   town prototype, the budgets. **Default:** build as shown.
2. **Tiger Girl's look:** `work/tmp/uniques/tigergirl_ride.gif` and `filmstrip_ride.png`. **Default:** as shown.
3. **The town prototype:** `work/tmp/town-life/proto-sheet.jpg` (plaza before/after, noon and night). **Default:** as
   shown. The prototype's smoke glows at night and its banners read mirrored from behind; both are fixed in the build
   (lit puffs, two-sided banner textures).
4. **Townsfolk wear the retail player garments** (muted tints, no name tags). **Default:** yes.
5. **By ear, after the build:** the two notice sounds (`alarm_sound.wav` on appear, `eventcomplete.wav` on defeat) and
   the synthesized town sounds (bed, chickens, hammer; dogs use the retail pet wolf pitched up). **Default:** those, quiet.
6. **One party kill with friends** to set `hpMul`. **Default:** 0.08 (≈ 5 minutes for 4 level-20 players).
7. **The B2 town batch before/after**, if its gate passes. **Default:** ships if it passes.
8. **The jump:** try P-JUMP (≈ 0.6 m lift, 0.7 s in the air) once the polish pass is in your build. **Default:** P-JUMP;
   if still low, MV-H raises it to ≈ 0.8 m.
9. **A friend's Mac and a gaming laptop:** one plaza run with town life and one fight run. **Default:** Macs and iGPUs
   start on "Town life: Low" and Grass: Low; ship on the dev PC's numbers.

---

## 9. Risks

| Risk | Default handling |
|---|---|
| The 20-player plaza crosses 16.7 ms on Medium (the town takes most of wave 10's margin) | the player-aware cap; LAB-11 on a quiet machine; cut 20 |
| The ÷ 1.5 is optimistic for the town's script work (TOWN F2) | undivided numbers carried in §5.2; G3-11 flagged at risk; TL-C's optimisation list |
| High's TAA smears walkers (certain, seen in the prototype) | G5; reprojection for the crowd, else the MSAA ×4 override (D4) |
| The VAT clock fed epoch seconds freezes the crowd (TOWN F5) | the rebased time base and its unit test |
| The composite drifts at transitions or LOD (UNIQUES F4/F5) | `lodLeader`, suppressed self-resume, the tests; H-11 lens 1 |
| The death cut mid-fall (3 s corpse) | `corpseSec` 8 (never cut) |
| 20 players at the boss: High WebGPU, laptops and M1 miss 60 fps | reported; BACKLOG item 9; nothing in this wave can lower it |
| Step 0 waits on the polish commit | the data and scratch lanes start now; the seams are S–M |
| The east pond is a wave-10 regression | TL-B checks first (D21); F-11 fixes a bug; H-11 lens 12 |
| The WebGL2 far-terrain blotches have a deep cause | GF-R diagnoses; if not fixed in the wave, the release notes it for WebGL2 users |
| Clicks on the crowd eat click-to-move | the non-consuming pick, not pickable meshes; H-11 lens 9 |
| Townsfolk mistaken for players | no name tags, muted tints; the user judges (§8 item 4) |
| Synthesized sounds sound cheap | quiet defaults; the user's ear; the CC0 option (§10 Q9) |
| A migration lands elsewhere first | I-11 renumbers; the test asserts the list length |
| Fury griefing or summon-reset farming | accepted on a friends server (UNIQUES §10); GM `/unique despawn` + `timer` |
| The field boss rolls camp 5906 (the Binding Bell's shrine) | accepted; either kill counts for JG_025 (UNIQUES Q7) |

## 10. Open questions (each has a default, so nobody waits)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | Defeat notice names the last hitter instead of the loot-owner group? | the loot-owner group | the user |
| Q2 | Tell players who log in while she is alive? | no (retail has no replay) | — |
| Q3 | Re-home Cerberus (24) into the Jangan fields as a second boss? | no | the user |
| Q4 | Announce the Binding Bell's private Tiger Girl too? | no | — |
| Q5 | Uniques immune to stun and knockdown? | no immunity | — |
| Q6 | A shorter respawn for a small server (1–2 h)? | retail 3–6 h; `/unique timer` for events | the user after a week |
| Q7 | Keep camp 5906 in the roll? | yes | — |
| Q8 | How busy should the town be? | 60 / 100 / 140, −3 per player beyond 5 | the user after a walk |
| Q9 | A downloaded CC0 crowd/market/animal sound pack? | no (synthesized) | the user |
| Q10 | Children (the smallest female body at 0.82 scale)? | in (cut 6) | the user's look check |
| Q11 | Rumour lines tied to the player's questline act? | in | — |
| Q12 | The east pond: bug or look? | TL-B checks in game first (D21) | TL-B |
| Q13 | Crowd cast shadows on High? | blobs until LAB-11 measures cascade-0 casters within G2 | LAB-11 |
| Q14 | TAA reprojection for the crowd not fixable in wave 11? | MSAA ×4 while town life draws on High/Ultra | LAB-11 |
| Q15 | The jump higher than P-JUMP? | P-JUMP's 0.6 m; MV-H 0.8 m on request | the user |
| Q16 | Ring B on Grass: Low for Macs? | B1 only to 150 m if the 0.75-scale WebGL2 bench holds (cut 18) | GF-R |

## 11. Deferred

- **Wave 12 (the user):** fishing, swimming, underwater (and fish in the pond beyond the retail goldfish, anything below
  the water surface).
- **Still in the queue from wave 10** (WAVE_PLAN6 §11): the sky upgrade (SKY2), new tree models, the intro and login
  scene, the dodge roll, pets / friends / mail, the remaining 9B texture batches beyond the scoped B2 town batch, WebGPU
  snapshot rendering, production asset versioning, the Classic batch (BT-K), MV-L.
- **Not this wave:** other uniques (Cerberus, Captain Ivy, Uruchi: not on our map); a world-map boss marker; impostors
  for the crowd; townsfolk as server entities; a blade-scale normal for the far grass carpet; character batching and
  animation LOD for 20 players (BACKLOG item 9, the only fix for the 20-player High misses).

## 12. Housekeeping

- The two specs stay the detailed design; this plan's decisions override them where they differ (D1–D18 in
  particular: the five step-0 agents, the content split, the notice dispatch in W11-G, the post and water hooks).
  I-11 marks the overridden passages in the specs.
- No lane commits; the lead integrates each step. No lane starts or stops the user's dev servers (:5180, :7000,
  :5173); private servers on free ports with temp DB copies only.
- Scratch used by this plan: `work/tmp/w11-plan/budget.py` (the §5.2 arithmetic), `work/tmp/w11-plan/make_preview.py`
  (the preview sheet), `work/tmp/w11-preview.png`.
