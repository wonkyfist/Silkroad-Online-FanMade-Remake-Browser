# Wave plan 11: wave 14, "Wardrobe" (the character-performance foundation, cloth on garments, civilian clothes for the townsfolk, new armour and clothing sets, dyes)

This plan merges three fact-checked specs into one build order for wave 14:

- **docs/CHAR_PERF.md** (the foundation, steps 0/1): characters get three tiers. **T0** is your own character. **T1** is
  the few you look at: target, hover, party and the nearest on screen, capped at Medium 4, High 6, Ultra 12. Both stay
  skinned as today. **T2** ("the crowd") is everyone else: other players, NPCs and monsters at any distance. T2 is drawn
  as **one thin-instanced batch per outfit**, skinned from a baked bone-matrix texture (VAT) through our own plugin,
  `SroCrowdSkin`, with weapons as bone slots, a clip clock instead of Babylon animation groups, and the same pose when a
  character changes tier. Prototyped inside the real game page: on the 20-player plaza, WebGPU Medium p95 went from
  21.9 to 13.8 ms, and on the 20-player Tiger Girl fight from 27.6 to 15.0 ms (measured interleaved on a busy machine).
- **docs/CLOTH.md**: spring-bone chains on the garments that hang below the waist (robes, long skirts, panels, tails,
  sashes, tassels, capes), made offline by an auto-rig in the converter that reuses the retail client's own cloth data
  (155 meshes carry it; our converter drops it today). A pure CPU step runs at a fixed 60 Hz with deviation rendering,
  edge-vs-capsule collision and a tether. It runs only on you and T1, is off on Low, and lives in a separate
  `<item>.cloth.glb`.
- **docs/WARDROBE.md**: the townsfolk out of player gear: the 43 retail NPC outfits re-bound to the townsfolk
  skeleton, plus Blender pieces and a few Meshy retextures, 30 outfits with 8 colourways per variant and a converter
  check that no townsperson wears a player item. **88 new pieces** fill The Climb's named slots **W15-A…D** plus a new
  **W15-E** (Tailor's costumes), with two display-only costume slots. A **dye system** covers masks, 24 dyes plus
  Bleach, one shader plugin, the crowd palette, the Dye window, one additive migration and one client message.

The user's words, verbatim:

> All npc's walking around town should not have all same gears players have. Thats weird and boring.

> Is it possible to add physics to the clothings? Especially garmet since is supposed to be a garmet.

> create more clothing's

> Clothing dyes, so the new gear and civilian clothes can be recoloured.

> Lets make wave 15 actually wave 14, and current wave 14 make it wave 15

Weapons come later, in Arsenal (wave 17). The user chose the order: Wardrobe now, The Climb next. The standing goal is
**at least 60 fps**. Gate G1 is Medium p95 < 16.7 ms on WebGPU and WebGL2, on any GPU vendor. The 20-player scenes sit
at that line today, so **this wave's foundation fixes them first, and they must now pass with margin** (§6).

**The user delegated every decision.** Wherever there is a choice, this plan takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§2). Only what truly needs the user is left in §12
and §14, each with the default used meanwhile. **Deploy follows the standing rule** (the user, 2026-10-02: "After every
wave, just deploy."): wave 14 deploys after its independent verify (V-14). A miss that is only about frame time
deploys. Any other blocker is fixed first. A named DB backup is taken before migration 11 (D32).

This plan does what WAVE_PLAN10 did for The Climb:

- it settles every place where the three specs would give a file or a piece of state two owners, with **one owner per
  shared module**: `three/models.ts`, the appearance package, the crowd variants, the converter's equipment export, the
  character shaders, the tier ranking, the wire and the database (§2.1, §2.2);
- it fixes the format additions (one migration, the wire, the export folders, the content folders) in one list (§3);
- it lands **the seams first** (§4), on disjoint files, and then **the character-performance foundation** (step 1)
  with a gate of its own (checkpoint X1) **before** cloth, the civilian clothes, the armour sets and the dyes merge
  (step 2);
- it holds the sum of the three specs against G1 with margin on Medium and against G2 on High, per backend and per
  vendor (§6);
- it orders the lanes, the re-converts, the integration, the bench, a hunt with lenses, the fixers, a final gate and
  an independent verify (§7). It also covers the data migration (§8), one scope-cut order with a never-cut list (§9),
  the W15 slots filled for The Climb (§10), the GM teleport places (§11), what the user approves (§12), risks (§13),
  open questions (§14), the renumbering (§15), hooks (§16) and housekeeping (§17).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads
its spec sections and this plan's row for it.

**Tags** (as in WAVE_PLAN10):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-03, measured by a spec's prototype and
  re-derived by its fact-check, or computed by this plan's own scripts. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived); not observed on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes. The user may overrule it.

**Repo state when this was written** [confirmed: `git log`, `git status`, `db.ts`, NIGHT_LOG, 2026-10-03 09:20]:

- HEAD `9629429` (the mini-wave: rain, GM teleport places, WASD, the plaza dragon, god rays; committed as a checkpoint
  with G5 red). The tree is clean except for the three specs (untracked).
- **Wave 12 and the mini-wave are being finished**: the verify read NOT SAFE on G5 (grave_tree at dusk), and the
  follow-up `w12g5-fix.js` is running (NIGHT_LOG 09:07). **Waves 10 and 11 are live.** Wave 13 is pushed back after
  wave 17 (NIGHT_LOG 06:48). The Climb (WAVE_PLAN10) is designed and builds after this wave as **wave 15**.
- **The database is at schema 10** (`MIGRATIONS` in `apps/server/src/db.ts`: 10 entries, the last being the uniques
  table), so this wave takes **11** (D27).
- Code facts this plan leans on, re-read: `buildMerge` walks the body glb's own parts only (`models.ts` 1514, `worn`
  is separate, 1110); `town/crowd.ts` writes the instance colour's rgb as 1 (823–827); `ShadowCasterSource` has no
  cascade field (`shadows.ts` 1139); the surface plugin injects at `CUSTOM_FRAGMENT_UPDATE_ALBEDO` (`surface-plugin.ts`
  410); `PARTY_MAX = 8` (`protocol.ts` 1387); `VAT_MAX_BYTES = 2,500,000` and `VAT_MAX_FRAMES = 4096` (`town/vat.ts`
  37–39); `VARIANT_MAX_TRIANGLES = 3000` (`variants.ts` 34); `townLifeFor` in `settings.ts`; `tp npc <name>` in `gm.ts`
  (253–256); `content/places.json` holds 29 rows; JG_002's kill hint is `LOC_MILLET_FIELDS`.
- **Meshy:** the designs spent **40 credits** (WARDROBE's bake-off, NIGHT_LOG 07:03–07:08; balance 1,690). This plan
  spent **0**. The build plans **≤ 450, cap 600** (D31). Nothing was downloaded.
- This plan's scratch is in `work/tmp/w14w-plan/`. `budget.py` holds the §6 and §7 arithmetic (output in
  `budget.json`), and `make_preview.py` makes the preview sheet `work/tmp/w14w-preview.png`, which is also in Dropbox
  as `wave14/wardrobe-preview.png`.

---

## 0. Summary

1. **Foundation first.** Step 0 lands six seam agents on disjoint files (§4). Step 1 builds the **crowd tier** (CP-V
   export, CP-R renderer, CP-A actor tiers with CP-S's small cuts, CP-L bench rows). Checkpoint **X1** re-converts
   with the new `crowd` verb and runs the **foundation gate**: the 20-player plaza must read ≤ 12 ms and the fights
   ≤ 13 ms p95 on WebGPU Medium (≤ 9 / ≤ 10 on WebGL2), on a quiet machine, **before** any cloth, new art or dye
   merges. Work that adds no frame cost runs in step 1 alongside, on new files or in scratch: the cloth rig and the
   pure sim, the masks, the converter's re-bind, the art in Blender and Meshy, the server and the content.
2. **Then, in this merge order (step 2): cloth, civilian clothes, armour sets, dyes.** Cloth (CL-G on CL-R/CL-S) is
   gated by LAB-CL1 on top of the foundation. The civilian crowd (WR-CV and WR-ART-CIV) comes next, then the armour
   and costume sets (WR-ART-A/B/CDE), then the dye runtime and UI (WR-R, WR-UI). Checkpoint **X2** is the full
   re-convert. Then step 3: **I-14** integration → **LAB-14** bench → **H-14** hunt → **F-14** fixers → **G-14** final
   gate → **V-14** independent verify → deploy.
3. **One owner per shared module** (§2.1):
   - `three/models.ts`: **W14-G** (seams), then **CP-A** only. Cloth and dyes reach it through hooks.
   - The appearance package: **W14-AP**, then frozen.
   - The crowd variants: **WR-CV** (the converter) and **WR-ART-CIV** (the catalogue rows).
   - The converter's equipment export: **W14-CV** (the manifest fields, verbs and hooks), then **WR-CV** (`sets.ts`),
     **CL-R** (`cloth-rig.ts`) and **CP-V** (`crowd/**`).
   - The character shaders: `SroCrowdSkin` is **CP-R**'s; the dye plugin and the one shared dye formula are
     **WR-R**'s; `foliage-plugin.ts` and `surface-plugin.ts` are not edited.
   - The tier ranking (`crowd-budget.ts`): **CP-A**. Cloth reads the same ranking.
4. **The three specs, joined** (§0.3): cloth runs on exactly T0 + T1 (Medium 5, High 7, Ultra 13), with no separate
   "warm" actors. T2 wears the plain glb. A new set in T2 is one layer of the 512² atlas array inside its wearer's
   outfit batch, not 6 batches. A dye in T2 is a per-vertex equipment slot plus a per-instance dye-row index. The
   townsfolk's cloth is WARDROBE's cloak back chain, baked into the VAT at 0 bytes, not CLOTH's ring. An Apple or
   integrated-GPU rule keeps the M1 fight under the line.
5. **Formats (§3):** one migration (**11**: `items.dye`, `storage_items.dye`, `char_grants`), additive wire
   (protocol v1), new export folders (`crowd/`, `<item>.cloth.glb`, set atlases and masks, new town variants), and
   content under `content/{cloth, wardrobe, items, shops}`.
6. **Budgets (§6)** [projected: `budget.py` on the specs' measurements]: WebGPU Medium 20-player plaza **≈ 9.7–10.9
   ms** and fights **≈ 10.6–11.9 ms** with everything on (target 12 / 13, line 16.7); WebGL2 ≈ 6.7–8.2; High plaza
   ≈ 13.3–13.4 (≤ 14), High fight ≈ 15.3 with D15's step 2 (≤ 16). An **M1** reads the Medium fight at ≈ 15.1–17.0
   without the Apple rule, which can cross G1, so **D16** halves T1 in crowd fights on Apple and integrated GPUs
   (≈ 14.2–16.1). LAB-14 measures all of it on a quiet machine.
7. **Never cut** (§9): the perf foundation (T2 with one draw per outfit, the crossfade, the sockets, the seamless
   promotion, the X1 gate), cloth on robes and skirts (the tier-A panels and robes on your own character at least, the
   deviation rendering, the edge collision), civilian clothes for the townsfolk (no player gear, the content check),
   dyes (masks, the plugin, the Dye window, the wire), W15-B and W15-D obtainable now, the Low guard, and G1 with
   margin.
8. **What the user must do (§12):** nothing blocks the start. Look at the preview sheet. Meshy ≤ 450 credits for the
   art (default: yes). The look checks per set (default: the art lane's pick). After the build, about 30 minutes of
   play. A friend on a Mac for one minute (N1). The deploy follows the standing rule.

### 0.1 Where each user request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "All npc's walking around town should not have all same gears players have" | WARDROBE §3: NPC-outfit re-binds, new civilian pieces, `town-wardrobe-check` (both ways, D3 there) | WR-CV, WR-ART-CIV, WR-MASK |
| "Thats weird and boring" | WARDROBE §3.5–§3.7: 30 outfits, 8 colourways per variant, no two alike within 12 m, roles filter outfits, guards in garrison uniforms | WR-CV, WR-ART-CIV, WR-R (palette) |
| "Is it possible to add physics to the clothings?" | CLOTH §4–§6 (auto-rig, sim, tiers), with this plan's D14 (cloth = T0 + T1) | CL-R, CL-S, CL-G, CL-L |
| "Especially garmet since is supposed to be a garmet" | CLOTH §2.3 (the garment class's retail cloth panels first), WARDROBE §4.7 (every new garment robe gets a ring chain); never cut | CL-R, WR-ART-A/CDE |
| "create more clothing's" | WARDROBE §4: 88 pieces (W15-A…E), the costume slots; weapons stay in Arsenal | WR-ART-A/B/CDE, WR-D, WR-SV |
| "Clothing dyes, so the new gear and civilian clothes can be recoloured" | WARDROBE §7: masks, 24 dyes + Bleach, `SroDyePlugin`, the crowd palette, the Dye window; T2 per D17 | WR-MASK, WR-R, WR-SV, WR-UI, CP-R |
| "Lets make wave 15 actually wave 14, and current wave 14 make it wave 15" | this plan is wave 14; §15 lists the renumbering of The Climb's documents, ids and migrations | the lead (step 0 docs commit) |
| (task) "this wave's foundation must fix that before adding cloth/hair cost" | CHAR_PERF; step 1 and the X1 foundation gate before step 2 (D1, §7.0) | CP-* |
| standing goal "at least 60 fps" on any vendor | §6: G1 with margin, G2, the vendor and Apple notes, N1 | LAB-14, G-14 |

### 0.2 What the specs' fact-checks changed, and this plan takes as given [confirmed: each spec's fact-check section]

| From | Change | Where it lands here |
|---|---|---|
| CHAR_PERF §0.2 #1 | Medium keeps the rescue's blobs for T2 beyond cascade 0 (≈ 11.5 m from the camera) | CP-R; D11 there |
| CHAR_PERF #2 | T1 is a hard cap (Medium 4, High 6, Ultra 12) filled by target and hover, then party, then the nearest | CP-A; D14 |
| CHAR_PERF #3 | T2 wears a cloth garment's plain glb; no "crowd skin" re-weighting | CP-V; D14 |
| CHAR_PERF #4 | VATs: skills at 15 rows/s, ≈ 3.0 / 4.2 / 5.0 / 5.7 MB per gender and family, ≤ 4,096 rows, ≤ 8 at once (≈ 35 MB) | CP-V; §6.5 |
| CHAR_PERF #5, WARDROBE F18 | Dyes per piece in T2: an instance dye-row index | **D17** (with the per-vertex slot) |
| CHAR_PERF #6 | A second 512² array for set atlases; a mask array; arrays ≤ 40 MB | CP-V; D18 |
| CHAR_PERF #7 | One pipeline per outfit: both windings, interleaved buffers (WebGPU's 8), one flat varying (15 of 16 used) | CP-R; G4 |
| CHAR_PERF #8–#10 | T2 never disables the actor root; stable slots; a `ShadowDepthWrapper` | CP-R, CP-A |
| CHAR_PERF #11, #12 | High fight with cloth ≈ 16.2 → D23 step 2 (T1 2); M1 ≈ 0.7× the dev PC's CPU | **D15, D16** |
| CHAR_PERF #14 | Riders: a rider and its mount are one slot; the rider's matrix = mount × saddle socket | CP-A |
| CLOTH F1 | Non-simulated wearers wear the plain glb (zero cost); only sim actors wear the cloth glb | **D14** (and the warm buffer folded into T1's hysteresis) |
| CLOTH F2 | Chain sets span the items of one set (`owner`/`uses`) | CL-R, CL-G |
| CLOTH F3 | Edge-vs-capsule collision and foot capsules; a re-rendered GIF | CL-S (never cut) |
| CLOTH F4 | The rest ring and the capsules scale with Volume | CL-G; D24 |
| CLOTH F5 | The cloth block rides in the cloth glb's extras; seams in `@sro/appearance` and `dress()` | W14-AP, W14-G |
| CLOTH F11, F12, F15, F16 | Wind from `WeatherUniforms.wxB`; the LAB id LAB-CL1; laptop CPUs ×1.5–2; WebGL2 High already at G2's line | CL-W, LAB-14 |
| WARDROBE F1 | A set atlas saves no T1 draw today (`buildMerge` never touches worn items) | D19 |
| WARDROBE F2, F3 | Chains through CLOTH's auto-rig; the crowd's swing on `cloak01–04` at 0 VAT bytes | **D21** |
| WARDROBE F4 | The dye injects at `CUSTOM_FRAGMENT_UPDATE_ALBEDO`, priority 240 (before the surface plugin's 250) | WR-R, W14-WR |
| WARDROBE F6 | Shade from the albedo at run time; masks ship half-size RGB | WR-MASK, WR-R |
| WARDROBE F7, F8 | `Bip02 → Bip01` alias; `keepHead`; 2× stretch test | WR-CV |
| WARDROBE F11 | The authored-item merge is built here (wave 13 moved after 17) | **D12** |
| WARDROBE F12 | W15-B carries per-piece stats only; the family bonus is The Climb's | §10 |
| WARDROBE F13 | Low runs the same plugin on dyed pieces only; undyed Low byte-identical | D22 |
| WARDROBE F15 | A fully dyed player adds ≈ 180 bytes of JSON | §6.6 |
| WARDROBE F17 | W15-E never shares a glb or texture with a crowd outfit; the check runs both ways | WR-CV |

### 0.3 What this plan's own fact-check found when it put the three together

| # | Finding | Evidence | Decision |
|---|---|---|---|
| P1 | WARDROBE (§0 item 5, §4.6, D16, §8.2) still describes T2 as "one crowd batch per distinct part, so a new set is 6 batches". CHAR_PERF's final form draws **one batch per outfit**. | CHAR_PERF §2.3, §4.2, D1b [confirmed: read] | **D18**: in T2 a new set is one layer of the 512² atlas array inside each wearer's outfit batch, and its six pieces add no draw. WARDROBE's per-part text is superseded. |
| P2 | WARDROBE D34 puts the equipment slot in "a batch uniform". With one batch per outfit, one batch holds all of a character's pieces. | CHAR_PERF §2.3, §0.2 #5 | **D17**: the slot is per vertex, packed with the layer index into the one flat varying. |
| P3 | CLOTH's counts (Medium 5 sim + 2 warm, High 10 + 2, Ultra 20 + 2) need 7 / 12 / 22 live skeletons. CHAR_PERF's cap is T0 + 4 / 6 / 12. The "warm" actors exist to stop swap churn at the rank edge, but under the tiers the rank edge is the T1 ↔ T2 promotion, which already has a 3 m / 1 s hysteresis and keeps the skeleton for 10 s. | CLOTH §6.5; CHAR_PERF §2.1, §2.2, Q6 | **D14**: cloth sims = T0 + T1 (Medium 5, High 7, Ultra 13). No warm actors. The cloth glb is picked when an actor is promoted, and `swapWorn` serves only the live Options switch and the Near mode. |
| P4 | **An M1 can miss G1 in the 20-player fight.** The Medium fight with everything on is ≈ 10.6–11.9 ms on the dev PC; ÷ 0.7 for an M1's single thread gives ≈ 15.1–17.0 ms. CHAR_PERF only projected the foundation (≈ 15). | `budget.py` [projected] | **D16**: on Apple and integrated GPUs, Medium T1 drops to 2 in a crowd fight, cloth sims to 3, and T2 uses `'nearest'` beyond 25 m (≈ −0.9 ms on an M1: ≈ 14.2–16.1 [projected]). N1's Mac run settles it. |
| P5 | The migration numbers moved. WAVE_PLAN10 D5 gave The Climb 14–16 behind wave 13's 11–13; wave 13 now comes after wave 17. | `db.ts` [confirmed: 10 migrations]; NIGHT_LOG 06:48, 06:54 | **D27**: Wardrobe = **11**; The Climb = 12 (CLIMB), 13 (TOMB), 14 (NEMESIS); wave 13 numbers after 17's. Migrations are numbered at merge. |
| P6 | The Climb's lane ids `W14-PR/CL/SV/SP/CV/WR/G`, `LAB-14`, `I-14` … would collide with this wave's. | WAVE_PLAN10 §1 | **D34**: The Climb's become `W15-*`, `LAB-15`, `I-15`, … in the renumber commit. The slot ids W15-A…E are single letters, so nothing collides. |
| P7 | CLOTH's CL-V (a generic 8 × 3 ring, +24 joints) puts the men's townsfolk VAT at ≈ 3.44 MB, over `VAT_MAX_BYTES` 2.5 MB. WARDROBE's back chain on `cloak01–04` costs 0 bytes. | `vat.ts` 37 [confirmed]; WARDROBE F3 | **D21**: WARDROBE's back chain; CL-V is re-scoped to bake it. |
| P8 | WAVE_PLAN10 D50 asks for "a new OK" to deploy. The user's standing rule since 2026-10-02 10:42 is "After every wave, just deploy." The live rates change to ×1 belongs to The Climb, now wave 15. | NIGHT_LOG 10:42; PROJECT_STATUS "Going live" | **D32**: this wave follows the standing rule. The rates line moves with The Climb. |
| P9 | The Dropbox `wave14/` folder holds The Climb's preview (`w14-preview.png`, 2026-10-02). | directory listing [confirmed] | This plan writes `wave14/wardrobe-preview.png` beside it and moves nothing. The renumber commit moves The Climb's file to `wave15/` (§15). |
| P10 | The 20-player harness dresses every bot alike (CHAR_PERF R7), which is instancing's best case. | CHAR_PERF §11.2 | **D35**: the gate includes the all-different-outfits plaza row, dressed in this wave's new sets and dyes. |
| P11 | CHAR_PERF's `crowd` verb reads the plain equipment glbs, the masks and the set atlases. CLOTH's `cloth` verb reads the plain glbs. The town export reads the variants. Nothing names an order. | the three lanes' inputs | **D6**: `convert` (equipment, new sets) → `wardrobe-masks` → `cloth` → `crowd` → `town` → `optimize-out`; X1 and X2 run that chain. |
| P12 | The dye maths would live in three places: the actor plugin, the townsfolk path and `SroCrowdSkin`. | WARDROBE §7.3; CHAR_PERF §2.3 | **D7**: one shader snippet exported by `pbr/dye-plugin.ts`, included by all three; a parity test. |
| P13 | GM teleports: the new obtainable spot is the millet fields (W15-D's quest). The Tailor is an existing NPC. | `content/places.json` (29 rows, no millet row) [confirmed]; `gm.ts` `tp npc` | **D33**: add `millet-fields`; the Tailor is `/tp npc jang`. |

### 0.4 Meshy and downloads

- **Meshy:** the build plans **≤ 450 credits** (≤ 100 for the civilian retextures, 120 for W15-A, 120 for W15-B, 110
  for W15-C/D/E), with a **cap of 600**, keeping ≥ 1,000 of the 1,690 balance (WARDROBE D27).
  - One retexture job per **set atlas**; route C (text-to-3d) only for rigid props.
  - Every job runs through the repo's `MeshyClient` (the key is read by the client, never printed) and is a NIGHT_LOG
    row.
  - The CP and CL lanes plan 0.
- **Downloads:** **none**. Every source is in `work/extracted`, `work/out` or `work/remaster/pack`.

---

## 1. Lane ids

| Id | Step | From spec | What |
|---|---|---|---|
| **W14-SH** | 0 | WARDROBE WR-SEAM (shared part) | `packages/shared/src/{protocol, validate, content, content-check, index}.ts`: the costume slots, `ItemStack.dye`, `EntityState.dyes`, `appearance.dyes`, `itemDye`, error codes, `DyeDef` and the wardrobe content types; PROTOCOL.md |
| **W14-AP** | 0 | CLOTH §11, WARDROBE WR-SEAM | `packages/appearance/src/{manifest, compose}.ts`: `EquipmentModel.cloth?`, `.dye?`, `.crowd?`; `BoundItem.cloth?`, `.dye?`; the costume drawing rule |
| **W14-SV** | 0 | WARDROBE WR-SEAM (server part) | `apps/server/src/db.ts` (migration 11), the wardrobe drop-overlay hook in the loot chain, the `char_grants` helper, GM dispatch rows, the `millet-fields` row in `content/places.json` |
| **W14-CV** | 0 | CHAR_PERF CP-0 (converter), CLOTH (cli line, manifest), WARDROBE WR-SEAM (authored merge) | `packages/convert/src/cli.ts` (`crowd`, `cloth` verbs), `data/authored.ts` (new) + one line each in `data/items.ts`, `data/shops.ts`, `equipment/manifest.ts` (`model.cloth`, `dye`, `crowd`), the equipment export's new-set hook, the `town/vat.ts` joint-override hook, the optimize-out entries |
| **W14-WR** | 0 | CHAR_PERF CP-0 (world-render), WARDROBE WR-SEAM (plugin skeleton) | `packages/world-render/src/crowd/` (the shared VAT pieces moved out of `town/crowd.ts`, no behaviour change), `render/shadows.ts` (`ShadowCasterSource.cascades?`), `pbr/dye-plugin.ts` (skeleton + the shared dye snippet), the actor decoration and warm-up registrations, the `material-budgets.test.ts` rows |
| **W14-G** | 0 | CHAR_PERF CP-0 (game), CLOTH §11 hooks | `apps/game/src/three/models.ts` (tiers, clip clock, lazy groups, cloth hooks, `swapWorn`, the `dress()` cloth pick, the dye hook), `world/crowd-budget.ts` (`tierOf`, counts, the Apple rule constants), `settings.ts` (`ClothSetting`, `clothFor`), `hud/options.ts` row, i18n and feature registrations, the mock server's fields |
| **CP-V**, **CP-R**, **CP-A**, **CP-L** | 1 | CHAR_PERF §13.2 | the crowd export, the crowd renderer, the actor tiers (CP-S folded in, D3), the LAB rows and the outfit dresser |
| **CL-R**, **CL-S** | 1 (new files) | CLOTH §15.2 | the auto-rig and cloth export; the pure sim (with the edge collision) |
| **CL-G**, **CL-L**, **CL-W** | 2 | CLOTH §15.2 | the game's `ClothSystem`; LAB-CL1–5 and tuning; wind, hats and sleeves |
| **CL-V**, **CL-B** | 2 (cut 1–2) | CLOTH §15.2, re-scoped by D21 | the townsfolk's baked back chain; the Blender fix-up |
| **WR-CV**, **WR-MASK** | 1 (scratch output) → 2 | WARDROBE §13 | the converter (re-bind, variants, set atlases, the check), the mask proposer |
| **WR-ART-CIV**, **WR-ART-A**, **WR-ART-B**, **WR-ART-CDE** | 1 (scratch) → 2 | WARDROBE §13 | civilian art, Terracotta Regalia, Tiger-Hunter's, the costumes |
| **WR-R**, **WR-UI** | 2 | WARDROBE §13 | the dye runtime (plugin, the townsfolk palette, the dyed clones), the Dye window and Tailor tab |
| **WR-SV**, **WR-D** | 1 | WARDROBE §13 | the server (dye, bleach, shops, drops, the grant); content rows and the 113 icons |
| **X1**, **X2**, **X3** | checkpoints | D28 | re-converts; X1 also runs the foundation gate |
| **I-14**, **LAB-14**, **H-14**, **F-14**, **G-14**, **V-14** | 3 | — | integration, the bench (LAB-CP + LAB-CL1–5 + WR-LAB rows), the hunt, fixers, final gate, verify |

**Dropped or folded ids:** CP-0 → W14-CV + W14-WR + W14-G. CP-S → CP-A (D3). CLOTH's "seam agents" → W14-AP, W14-CV,
W14-G. WR-SEAM → W14-SH + W14-AP + W14-SV + W14-CV + W14-WR. WR-LAB → LAB-14. CLOTH's warm actors → D14.
"LAB-14" in TOMB_DUNGEON becomes LAB-15 (D34).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | **When wave 14 starts, and the order** | all three; the task | Wave 12 and the mini-wave are not final (the G5 fix is running); the task wants the foundation first | **Step 0 starts from the final commit of wave 12 + the mini-wave** (after its G5 fix and its verify) [decision]. Every seam agent re-reads its files there. **Order:** step 0 seams → step 1 the foundation (CP-*) → **X1 with the foundation gate** → step 2 cloth, then civilian clothes, then armour sets, then dyes → X2 → step 3. **Before step 0, new files only, writing scratch outputs:** CL-S (`cloth-sim.ts` is pure), CL-R's rig in `work/tmp/w14-cloth/`, WR-MASK's proposer, WR-CV's re-bind in scratch, and the art lanes' Blender and Meshy work into `work/tmp/w14-art/`. Reason: no seam rebases onto an unfinished tree; the long art work leaves the critical path; nothing that costs frame time merges before the foundation passes. |
| D2 | **One step 0** | CHAR_PERF CP-0, CLOTH §11 "the seam agents", WARDROBE WR-SEAM | Three seam plans touch `models.ts`, the appearance package and `cli.ts` twice each | **Six seam agents on disjoint files** (§4): W14-SH, W14-AP, W14-SV, W14-CV, W14-WR, W14-G [decision]. Afterwards only I-14 edits their files, except where §2.1 hands a file to one lane. Reason: one agent per spine file (WAVE_PLAN10 D2, D4). |
| D3 | **`apps/game/src/three/models.ts`** | CP-0, CP-S, CP-A; CLOTH (hooks, `swapWorn`, `dress()` pick); WARDROBE WR-R (per-part dyes, dyed clones) | Four lanes want the 2,522-line actor file | **W14-G lands every seam in step 0**: `tier`, `toCrowd()`/`toFull()` stubs, the `ClipClock` interface, lazy animation groups behind `group(name)`, the cloth hooks (the chain nodes go into the joint map before `bindSkinned`; register and unregister on `bindSkinned`, `removeWorn`, dispose and `setVolume`), **`swapWorn(code, container)` complete with its test**, the `dress()` cloth-glb pick through `BoundItem.cloth`, and a `setDyes(slotDyes)` hook calling a `PartMaterialHook`. **After step 0, CP-A is the only lane that edits `models.ts`**; it lands CP-S's cuts first, as their own commits. **CL-G** owns `three/cloth.ts` and **WR-R** owns the new `three/dye-materials.ts` (the dyed-clone cache keyed by (material, dye key), unfreeze for one frame), both reached through the hooks [decision]. Reason: one writer for the file every lane leans on; the hooks make cloth and dyes testable without it. |
| D4 | **The appearance package** (`packages/appearance/src/{manifest, compose}.ts`) | CLOTH (`EquipmentModel.cloth?`, `BoundItem.cloth?`), WARDROBE (`dye?`, the costume rule), CHAR_PERF (crowd mesh refs) | Three specs edit the same two files | **W14-AP lands all of it in step 0**: `EquipmentModel.cloth?: { glb }` (the rig block rides in the glb's extras, CLOTH CL-D19), `dye?: { mask, channels }`, `crowd?: { mesh, layer, atlas? }`; `BoundItem.cloth?`, `BoundItem.dye?`; the costume rule in `composeWorn` (a worn `costume` hides the six armour slots, weapon and shield still drawn; `costumeHat` replaces the head piece; both list REPLACE slots like armour). Then the files are **frozen** (I-14 only) [decision]. The viewer and the converter tests call `composeEquipment` too and ignore the new fields. Reason: a shared package with three consumers gets one writer. |
| D5 | **The crowd variants** (TL-V) | WARDROBE §3 (re-bind, catalogue, colourways, masks), CLOTH CL-V (baked swing), CHAR_PERF (shared crowd pieces) | `variants.ts`, `vat.ts`, `town/crowd.ts` would have three writers | Converter side: **WR-CV owns** `town/variants.ts` and the new `town/npc-outfit.ts`. **WR-ART-CIV owns** the catalogue rows in `content/wardrobe/town.json`; WR-CV owns their format. `town/vat.ts` gets one **joint-override hook** from W14-CV in step 0, and **CL-V owns** the new `town/cloth-bake.ts` that fills it (D21). Runtime side: W14-WR moves the shared pieces (`vatOffsetFor`, the rebased time base, `SroTownFadePlugin`, the warm-up hook) to `world-render/src/crowd/`; then **WR-R owns `town/crowd.ts`** (the palette path, the global row in the instance colour's green) and **CP-R owns `crowd/**`** [decision]. Reason: one writer per file; the townsfolk stay on their tested VAT path. |
| D6 | **The converter's equipment export** | CHAR_PERF CP-V (crowd meshes, arrays, VATs), CLOTH CL-R (cloth glbs, manifest `model.cloth`), WARDROBE WR-CV (new sets, set atlases, `dye` in the manifest) | Three lanes add to the equipment export and its manifest | **W14-CV lands** in step 0: the manifest fields (`model.cloth`, `dye`, `crowd`; the version unchanged, `isEquipmentManifest` ignores extras), a **new-set hook** in the equipment export (it reads `content/wardrobe/sets/*.json` when present), the `cloth` and `crowd` verb lines in `cli.ts`, and the optimize-out entries. Then **WR-CV owns `equipment/sets.ts`**, **CL-R owns `equipment/cloth-rig.ts`**, **CP-V owns `convert/src/crowd/**`**. **One pipeline order:** `convert` (equipment, new sets) → `texpipe wardrobe-masks` → `cloth` → `crowd` → `town` → `optimize-out` [decision; P11]. With the new inputs empty the export is byte-identical (G7). Reason: one owner of the manifest; each verb owns its outputs. |
| D7 | **The character shaders** | CHAR_PERF (`SroCrowdSkin`, `ShadowDepthWrapper`), WARDROBE (`SroDyePlugin`, the crowd's `SRO_DYE_INST`), the surface plugin (wet darkening at `UPDATE_ALBEDO` 250) | The dye formula would exist three times; the foliage plugin's pattern is borrowed | **`crowd/skin-plugin.ts` (SroCrowdSkin, WGSL and GLSL) is CP-R's.** **`pbr/dye-plugin.ts` is WR-R's** (the skeleton by W14-WR): the actor plugin at `CUSTOM_FRAGMENT_UPDATE_ALBEDO` priority 240, **plus one exported shader snippet** (`sroDyeApply` in GLSL and WGSL: mask read, shade from the albedo, three mixes) that SroCrowdSkin and the townsfolk's `SRO_DYE_INST` path include, so there is **one dye formula** [decision; P12]. **No lane edits `pbr/foliage-plugin.ts`** (CP-R copies its `ShadowDepthWrapper` pattern) **or `pbr/surface-plugin.ts`** (its priority 250 stays after the dye). `material-budgets.test.ts`: W14-WR adds the row skeletons ("player crowd", actor and crowd sets with `SRO_DYE`), CP-R and WR-R fill them. Reason: one owner per shader file, one formula, no regression in the foliage path. |
| D8 | **The tier ranking** (`apps/game/src/world/crowd-budget.ts`) | CHAR_PERF CP-A (ranking, cap, hysteresis), CLOTH (its own 250 ms rank) | Two rankings of the same actors | **One ranking**: W14-G adds `tierOf(actor)` and the per-preset counts in step 0; **CP-A owns the ranking**. The `ClothSystem` reads `tierOf` and runs no ranking of its own [decision]. Reason: two rankings would disagree at the edge and swap twice. |
| D9 | **Shadows** (`render/shadows.ts`) | CHAR_PERF D12 | One optional field | W14-WR adds `ShadowCasterSource.cascades?: number`; CP-R uses it. No other lane edits `shadows.ts` [decision]. |
| D10 | **The wire, content types, the database** | WARDROBE §7.6 | — | **W14-SH** owns the wire and content types (§3.1), **W14-SV** owns migration 11 and the loot-chain hook (§3.2). Afterwards I-14 only. Cloth is local (no wire); the tiers are local (no wire) [decision]. |
| D11 | **Settings and Options** | CLOTH §8 (`ClothSetting`, the Options row), WARDROBE (none) | — | W14-G registers `ClothSetting` and `clothFor` (the `townLifeFor` pattern, with the Apple rule of D16), the Options row and the i18n files `en-cloth.ts` and `en-wardrobe.ts`. CL-G and WR-UI fill the text. No other new setting this wave [decision]. |
| D12 | **The authored-item merge** | WARDROBE D29 / F11; WAVE_PLAN10 W14-CV (the extension to mobs, skills, cos); FISHING FS-I | Wave 13 was to build it and now comes after 17; The Climb extends it | **W14-CV builds `packages/convert/src/data/authored.ts` now** (items and shops; a retail-code collision, a missing model or a missing icon are errors), in FISHING FS-I's format [decision]. The Climb's seam (renamed W15-CV, D34) extends it to mobs, skills and cos; wave 13 reuses it. Reason: none of the 113 new items exists in game without it. |
| D13 | **The server** | WARDROBE WR-SV | The loot chain is The Climb's later | **WR-SV owns `apps/server/src/wardrobe.ts`** (`itemDye`, bleach, the §7.5 rules), the shop rows' behaviour and the JG_002 grant. **W14-SV adds one provider slot** in the loot chain (`wardrobeDrops(m)` before the retail table, reading `content/wardrobe/drops.json`). The Climb's chain later puts its providers ahead of it, and its `drops.json` replaces the interim rows [decision]. |

### 2.2 State ownership (one source of truth each)

| State or module | Produced by | Consumed by | Owner lane |
|---|---|---|---|
| An actor's tier (T0/T1/T2), the cap per preset, the Apple rule | `crowd-budget.ts` ranking every 250 ms | `models.ts` (`toCrowd`/`toFull`), `ClothSystem`, shadows (casters), labels | **CP-A** (W14-G the seam) |
| The T2 pose (clip, time, previous clip, blend) | the clip clock in `three/crowd-actor.ts` | the instance record, the sockets' CPU copy, effects and labels | **CP-A** |
| Outfit batches, the outfit cache, stable slots | `world-render/src/crowd/{batch, outfit, instances}.ts` | the frame | **CP-R** |
| Crowd VATs, crowd meshes, the albedo, atlas and mask arrays | `crowd/` export (`crowd/index.json`, `vat/*`, `mesh/*`, `array/*`) | CP-R | **CP-V** |
| Cloth rigs and tunes | `content/cloth/{rigs, tunes}.json` (format: CL-R; rows for new garments: the art lanes) | `pnpm sro cloth` | **CL-R** |
| Cloth simulation state (per actor, per chain set) | `three/cloth.ts` (`ClothSystem`), `three/cloth-sim.ts` | the chain `TransformNode`s | **CL-G**, **CL-S** |
| A piece's dyes (three ids packed in one integer) | `items.dye`, `storage_items.dye` (migration 11) | the inventory, the wire (`ItemStack.dye`, `EntityState.dyes`, `appearance.dyes`) | **WR-SV** (behaviour), **W14-SV** (columns) |
| The dye table (24 + Bleach) | `content/wardrobe/dyes.json` | server, client, the crowd palettes | **WR-D** |
| Dye masks | `content/wardrobe/masks.json` + texpipe's `wardrobe-masks` | the equipment export (manifest `dye`), CP-V (mask array), the variants | **WR-MASK** |
| The townsfolk catalogue and colourways | `content/wardrobe/town.json` | WR-CV's variants, the palette rows | **WR-ART-CIV** (rows), **WR-CV** (format) |
| A T2 character's dye row (8 slots × 3 channels) | the dye table texture in CP-R's renderer | `SroCrowdSkin` | **CP-R** (texture and slot), **WR-R** (the snippet) |
| The townsfolk palette (global row in the instance colour's green) | `town/crowd.ts` | the townsfolk material | **WR-R** |
| New items, shops and drops | `content/items/wardrobe.json`, `content/shops/wardrobe.json`, `content/wardrobe/drops.json`, icons | `data/authored.ts`, the server | **WR-D** (rows), **W14-CV** (the merge) |
| One-time grants (JG_002's W15-D catch-up) | `char_grants` (migration 11) | WR-SV; later The Climb's Incense grant (a hook) | **WR-SV** (W14-SV the table) |
| GM teleport places | `content/places.json` | `/tp` | **W14-SV** (this wave's row) |

### 2.3 Cross-feature behaviour

| # | Topic | Problem | Decision |
|---|---|---|---|
| D14 | **Cloth and the tiers** | CLOTH: Medium 5 sim + 2 warm, High 10 + 2, Ultra 20 + 2 (7 / 12 / 22 live skeletons); CHAR_PERF: T0 + 4 / 6 / 12 (P3) | **Cloth simulates exactly the T0 and T1 actors that wear a cloth-rigged garment: Medium 5, High 7, Ultra 13** (CHAR_PERF's counts). **No warm actors**: the T1 ↔ T2 hysteresis (3 m / 1 s, a skeleton kept for 10 s) does their job. **The cloth glb is chosen at promotion** (T2 → T1 builds the parts anyway), and T2 wears the plain glb. `swapWorn` is used only by the live Options switch and by Near mode (a T1 non-party actor wears the plain glb) [decision]. Reason: one ranking, one set of live skeletons, no second swap at a second edge. |
| D15 | **Crowd fights on High and Ultra** | High's 20-player fight ≈ 15.8 ms with T1 at 4, ≈ 16.2 with cloth [projected] | CHAR_PERF D23 as written: in a crowd fight (≥ 10 other characters fighting within 50 m) T1 drops to 4 on High and Ultra (and cloth with it); **step 2, T1 at 2, applies by default** unless LAB-14's quiet High fight with cloth reads ≤ 16.0 with T1 at 4 [decision; the projection is over the line, so the safe default ships]. |
| D16 | **Apple and integrated GPUs** | P4: M1 Medium fight ≈ 15.1–17.0 ms with the whole wave [projected] | On an Apple or integrated GPU (`settings.ts`'s existing detection), Medium: **T1 = 2 in a crowd fight** (4 otherwise), **cloth sims = 3** (you + 2; CLOTH's own Apple default), **`crowdSkin: 'nearest'` beyond 25 m** (CHAR_PERF §3.3) [decision]. Projected ≈ 14.2–16.1 ms on an M1. N1's Mac run measures it; if it reads over 16.0, T1 = 2 everywhere on those GPUs (one constant). Reason: G1 holds on any vendor, and the frame is CPU-bound. |
| D17 | **Dyes in T2** | WARDROBE D34 (batch uniform) vs CHAR_PERF (per vertex) (P2) | **The equipment slot is per vertex** in the outfit mesh, packed with the layer index and the array bit into the one flat varying. **The instance carries a dye-row index** into CP-R's dye table (one row per dyed T2 character: 8 slots × 3 channels, RGBA8, rewritten only on a dye or tier change). Monster elite tints and wave 15's nemesis tint are rows of the same table. The colour maths is D7's snippet [decision]. Reason: per-piece dyes inside one batch per outfit, still one instance write per character. |
| D18 | **New sets and costumes in T2** | WARDROBE "6 batches per set" vs CHAR_PERF one batch per outfit (P1) | **One outfit batch per distinct outfit**; a new set's 1024² atlas is **one layer of the 512² atlas array**, its mask a layer of the mask array; a costume is one crowd mesh like any item [decision]. A full new set in T2 adds no draw; twenty players in twenty outfits are twenty draws. |
| D19 | **New sets in T0/T1** | WARDROBE F1 | A new set draws like a retail set (6 pieces = 6 draws; no worn-item merge this wave, CHAR_PERF §4.1). **A costume saves 4–5 draws** per wearer. The set atlas stays the input of the later per-gear-combo merge (WARDROBE Q6; the performance pass) [decision]. |
| D20 | **The townsfolk** | — | They stay on their own VAT path (`town/crowd.ts` + the shared `crowd/` pieces), one draw per variant; Medium 10 / High 14 / Ultra 18 variants as today; **8 colourways per variant** through the instance colour's green (row + 1) / 256; the dye maths is D7's snippet; `!VERTEXCOLOR` guard (WARDROBE §7.3) [decision]. They are not moved onto `SroCrowdSkin` this wave (a hook, §16). |
| D21 | **Cloth on the townsfolk** | CLOTH CL-V's ring (+24 joints, men's VAT ≈ 3.44 MB > 2.5 MB) vs WARDROBE D10's back chain (0 bytes) (P7) | **WARDROBE D10**: robe tails, sashes and aprons of the crowd outfits are weighted to `cloak01–04` (+ the women's `Bone01/02` where an outfit lists them), simulated **offline** with CLOTH's pure `cloth-sim.ts` step over each clip loop (seam blended), and baked into the VAT as ordinary joint frames: 0 VAT bytes, 0 ms at run time. **CL-V is re-scoped** to `town/cloth-bake.ts` (1 day, not 1.5) and is the second scope cut [decision]. Player VATs (T2) bake no swing (D10 of CHAR_PERF: T2 wears the plain glb). |
| D22 | **Low and Classic** | — | No tiers, no VAT for players, no cloth (no module loaded, today's files), no new crowd code. **Dyes show** through the same plugin on dyed pieces' clones only; an undyed Low character is byte-identical to today (the Low guard gains that assertion) [decision: WARDROBE D21, F13]. New sets at a 256² tier of the set atlas on Low (WARDROBE §8.1). |
| D23 | **Cloth's gate on Medium** | CLOTH CL-D14 | LAB-CL1 runs **after X1** on top of the foundation: `cloth on − off ≤ 0.35 ms` CPU p95 on the 20-player plaza and the scene inside the G1-margin rows (§6.4). If it fails, Medium ships **Near** (you + party), High and Ultra keep their counts [decision]. |
| D24 | **Volume** (CHARACTER_SCALE E9) | three paths scale bodies | T2: the per-instance Volume step and the per-bone correction texture (CHAR_PERF §2.3). Cloth: the rest ring and capsules scale with Pelvis and Thigh factors (CLOTH CL-D20). New sets and costumes: the art lanes keep retail-style weights on the Volume bones and pass a Volume 0/4 check (no body through the piece at 1 cm) [decision]. |
| D25 | **Riders** | CHAR_PERF D26; CLOTH §6.4 "mounted" | A rider and its mount change tier together as one slot; a T1 rider's robe simulates over the horse (capsules as usual); a T2 rider wears the plain glb [decision]. |
| D26 | **Names** | CLIMB §4.3 "Tomb Warden's set" vs TOMB / WAVE_PLAN10 D27 "Terracotta Regalia" | **W15-A shows in play as the Terracotta Regalia** (WAVE_PLAN10 D27 stands); its row name stays an id; **W15-E "Tailor's costumes"** is this wave's new slot id; ids unchanged by the renumber (CHAR_PERF D21, WARDROBE D1) [decision]. |

### 2.4 Data, content, tools and delivery

| # | Topic | Decision |
|---|---|---|
| D27 | **Migration numbers** (P5) | **11 = Wardrobe**: `items.dye`, `storage_items.dye` (INTEGER NOT NULL DEFAULT 0), `char_grants (character_id, grant_id, at)`, landed by W14-SV in step 0. The Climb's three become **12 CLIMB, 13 TOMB, 14 NEMESIS** in the renumber commit; wave 13's follow wave 17's. `SCHEMA_VERSION = MIGRATIONS.length` keeps them ordinal [decision]. Reason: migrations are ordinal and land in build order. |
| D28 | **Re-converts** (under the convert lock; the lead) | **X1** after step 1: `convert` (no new sets yet) → `crowd` (VATs for both genders × 4 families, crowd meshes for every retail item and body, the albedo array) → `optimize-out run --only crowd/,equipment/`. Checks: every VAT ≤ 4,096 rows and ≤ 6 MB, the 1 / 3 mm pose tolerance, every equipment glb has a crowd mesh in the one layout, the field and town exports byte-identical (G7); then the **foundation gate** (§6.4). **X2** after step 2: the full chain of D6 with the new sets, masks, cloth glbs, the atlas and mask arrays and the new town variants, then a full optimize. Checks: `town-wardrobe-check` both ways, every mask matches its manifest bitmask, every `rigs.json` row passes `pnpm sro cloth`'s checks, every new item has an icon and a crowd mesh, TL-V budgets (≤ 3,000 triangles, VAT ≤ 2.5 MB), the arrays ≤ 40 MB. **X3** only for F-14 fixes that change an export. |
| D29 | **The GPU queue** | WAVE_PLAN8 D27's lock and rule (`mkdir work/tools/gpu.lock` must succeed; owner file "label time"; only the creator removes it; quiet machine CPU < 15 % for 30 s; 3 runs; median p95). Priority: bench timings (the X1 foundation gate, LAB-14, G-14, V-14) > review renders (turnarounds, the crowd sheet, the cloth clips) > anything else. A wave-14 GPU item waits behind any wave-12 holder. Blender and Meshy need no lock. |
| D30 | **Downloads and uploads** | **None** (Meshy jobs upload the repo's own retail meshes through `MeshyClient`, as WARDROBE's bake-off did). |
| D31 | **Meshy** | **Plan ≤ 450, cap 600**, by lane (§0.4); the first job is a pilot set atlas (WARDROBE R: atlas packing); one NIGHT_LOG row per job, the key never printed; the lane stops at its own cap and asks I-14 before borrowing. |
| D32 | **The deploy of wave 14** (P8) | **The standing rule:** deploy after V-14. A **perf-only miss** (a G1/G2 cell, a vendor projection) **deploys**, recorded in `budgets.md`, with the cheap levers applied first when they fix it (D15/D16 constants, cloth Near). **Any other blocker** (a failing test, G4, G7, the migration dry run, a never-cut item [failed] for a non-perf reason, a crash or black screen) **is fixed first**. Steps: a **named DB backup**, the migration dry run on a copy of the live DB (`apps/server/scripts/wardrobe-migrate-dryrun.ts`, W14-SV: every row count equal outside the new columns and table, every dye 0), one `pnpm run deploy` (code + assets), a health check (schema 11, the Tailor and Dyes tabs list, a dyed item round-trips, `crowd/index.json` served), the "reload the page" note. **No rates change** (that is The Climb's, wave 15). Wave 14 deploys after wave 12 + the mini-wave (its base) or together with them, never before. |
| D33 | **GM teleport places** (P13; the standing rule of NIGHT_LOG 14:20) | **One new row**: `millet-fields` (group `fields`, snapped by the places tool near JG_002's `LOC_MILLET_FIELDS` hint: the W15-D reward's mangyang and the farmer townsfolk walking south). The Tailor and the Dyes tab are **`/tp npc jang`** (an existing NPC). The bench spots exist (`plaza`, `tiger-camp-*`). W14-SV adds the row and runs `pnpm --filter @sro/server places --write` on the X2 export. |
| D34 | **The renumbering** (P6, the user's request) | The lead lands a **docs-only renumber commit** before step 0 (§15): The Climb's documents say wave 15; its lane ids become `W15-PR/CL/SV/SP/CV/WR/G`, `LAB-15`, `S-15`, `BAL-15`, `I-15`, `H-15`, `F-15`, `G-15`, `V-15`; its migrations 12–14 (D27); `wave14/w14-preview.png` moves to Dropbox `wave15/`. **The slot ids W15-A…D keep their names** (single letters; no collision with the two-letter lane suffixes) [decision]. |
| D35 | **The gate scene dressing** (P10) | LAB-14's 20-player rows run twice: bots in the starter outfit (comparable with every earlier gate) and **dressed by CP-L's dresser in random level-1–20 retail sets, this wave's sets and costumes, with random dyes** (the worst case for outfits and dyed clones). Both rows gate. |
| D36 | **Interim sources before The Climb** | WARDROBE D18 as written: W15-B from Tiger Girl (one piece, 20 %) and the current Tiger Mountains (0.3 % per kill); W15-D from JG_002 (+ the one-time grant); W15-E from the Tailor (40,000–120,000 gold); W15-A and W15-C ship `enabled: false` with the try-on mirror; the legendary dyes' rows disabled until wave 15. |
| D37 | **Stale clients** | Additive wire (protocol v1). An old client ignores `dyes`, the costume slots and `itemDye`'s answers; the deploy restarts the server and forces a reconnect. |
| D38 | **Scratch and docs** | I-14 updates the docs (§7.6). It deletes a spec's large scratch only after the owning lane has ported its method. It keeps every image the user reviewed: `charperf-sheet.png`, `cloth-proto.gif`, `wardrobe-preview.jpg`, this plan's sheet. |

### 2.5 Numbers and config (consolidated)

| What | Value | Source |
|---|---|---|
| T1 cap (others besides you) | Medium 4, High 6, Ultra 12; in a crowd fight High/Ultra 4, then 2 (D15); Apple/iGPU Medium 2 in a crowd fight (D16) | CHAR_PERF D2, D23; D15, D16 |
| T1 rank | target, hover (always), party, nearest on screen within 20 m; 3 m / 1 s hysteresis; ≤ 2 promotions a frame; skeleton kept 10 s after demotion | CHAR_PERF §2.1–§2.2 |
| T2 | any distance; one batch per outfit; VAT 30 rows/s base, 15 rows/s skills; ≤ 4,096 rows, ≤ 6 MB each, ≤ 8 at once; arrays 256² albedo, 512² atlas, masks, ≤ 40 MB | CHAR_PERF §2.3, §2.5 |
| T2 shadows | Medium cascade 0 + blobs beyond it within 50 m; High cascades 0–1; Ultra all | CHAR_PERF §6.2 |
| Cloth | sims = T0 + T1 (Medium 5, High 7, Ultra 13; Apple/iGPU 3); 20 m; 60 Hz; ≤ 2 ticks a frame; ≤ 64 chain bones per actor; off on Low | CLOTH §6; D14, D16 |
| Cloth setting | Options → Graphics → Cloth physics: Auto / Off / Near / Full | CLOTH CL-D13 |
| Townsfolk | 30 outfits (16 m, 14 w); Medium 10 / High 14 / Ultra 18 variants; 8 colourways; ≤ 2,500 triangles; no twin within 12 m | WARDROBE §3 |
| Sets | W15-A 36, W15-B 36, W15-C 4, W15-D 4, W15-E 8 = **88 pieces**, 22 sets; one 1024² atlas + 512² mask per set | WARDROBE §4 |
| Dyes | 24 + Bleach; Common 8 at 600 gold (Mrs Jang), Uncommon 8 (0.3 % field drops), Rare 6 (uniques, elites 2 %), Legendary 2 (disabled until wave 15); Bleach 200 gold | WARDROBE §7.4 |
| Migration | 11 | D27 |
| Meshy | plan 450, cap 600 | D31 |

---

## 3. Formats and content (additive)

### 3.1 Wire (`packages/shared/src/protocol.ts`, `validate.ts`, `content.ts`; W14-SH; protocol v1)

```ts
// EquipSlot: append 'costume' | 'costumeHat' to EQUIP_SLOTS (never indexed by position [confirmed: WARDROBE])
ItemStack.dye?: number                                    // p | s << 8 | t << 16; 0 = undyed
EntityState.dyes?: Partial<Record<EquipSlot, number>>    // only dyed slots; ≈ 180 B JSON for a fully dyed player
{ t: 'appearance'; ...; dyes?: Partial<Record<EquipSlot, number>> }
{ t: 'itemDye'; target: { equip: EquipSlot } | { bag: number }; channel: 0 | 1 | 2 | 'bleach'; dye: number /* bag slot */ }  // 2/s
// ActionFailReason: + 'dye_no_channel' | 'not_dyeable' | 'not_a_dye'
// content.ts: DyeDef { id: 1..255; code; name; srgb; tier: 'common'|'uncommon'|'rare'|'legendary' };
//   TownOutfitRow, WardrobeSetRow, WardrobeDropRow (content/wardrobe/*.json)
```

- The validators bound every new field (`dyes` ≤ 10 keys, each < 2²⁴; a costume item's slot must be a costume slot).
- Cloth and the tiers are client-local and add nothing to the wire.
- **Name check** [confirmed: grep of `protocol.ts` at HEAD]: there is no `dye`, `costume` or `itemDye` yet. W14-SH
  re-greps at the start commit.
- docs/PROTOCOL.md gains a "Dyes and costumes" section.

### 3.2 Migration 11 (`apps/server/src/db.ts`; W14-SV; D27)

```sql
-- 11: the Wardrobe (docs/WARDROBE.md §7.6)
ALTER TABLE items ADD COLUMN dye INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_items ADD COLUMN dye INTEGER NOT NULL DEFAULT 0;
CREATE TABLE char_grants (
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (character_id, grant_id));
```

- Old rows read as undyed. Stall listings live in memory and carry the dye.
- The migration test steps a schema-10 temp copy (from `work/server/game.db`) to 11 and keeps every row.
- **Back up the DB before the deploy** (D32).

### 3.3 Export layout (W14-CV the folders; the owning lanes the contents)

```
work/out/equipment/china/<sex>_item/<name>.cloth.glb      CL-R: retail mesh + materials unchanged, 43/45 joints in order, then cloth_k_j; root extras: the cloth block
work/out/equipment/china/<sex>_item/<new set pieces>.glb  WR-CV: one material per set (1024² atlas KTX2 + 512² RGB mask)
work/out/equipment/equipment.json                          + model.cloth?, dye?, crowd? (W14-CV fields; version unchanged)
work/out/crowd/index.json, vat/<skel>@<family>.{bin,json}, mesh/<item>.bin,
              array/<gender>{,-atlas,-mask}.ktx2           CP-V (sizes: §6.5)
work/out/town/variants/*.glb + mask atlases + palette rows WR-CV (TL-V format; the VAT per gender with the baked back chain, D21)
work/out/data/items.json, shops.json                       + the authored merge (W14-CV) of content/items/*.json, content/shops/*.json
```

### 3.4 Content

| Path | Owner | Validator |
|---|---|---|
| `content/cloth/rigs.json` (format, retail rows), `content/cloth/tunes.json` | CL-R | `pnpm sro cloth` checks (CLOTH §4.3) |
| `content/cloth/rigs.json` rows for new garments | the art lane that makes the garment (WR-ART-A/B/CDE, WR-ART-CIV for none: the crowd uses D21) | the same |
| `content/wardrobe/town.json` (outfits, layers, colourways) | WR-ART-CIV (rows), WR-CV (format) | `town-wardrobe-check`, TL-V budgets |
| `content/wardrobe/masks.json` | WR-MASK | texpipe `wardrobe-masks` (deterministic) |
| `content/wardrobe/sets/*.json` (set → pieces, atlas, chain rows) | WR-ART-A/B/CDE (rows), WR-CV (format) | WR-CV tests |
| `content/wardrobe/dyes.json`, `content/wardrobe/drops.json`, `content/items/wardrobe.json`, `content/shops/wardrobe.json`, `content/items/icons/**` | WR-D | `data/authored.ts`; content-check |
| `content/places.json` (`millet-fields`) | W14-SV | the places tool |

### 3.5 Settings, config, GM

- **Client:** `graphics.cloth: 'auto' | 'off' | 'near' | 'full'` (D11). The tiers and dyes have no setting. The tier
  counts are preset constants; an Advanced row is a hook (§16).
- **Server config:** none new.
- **GM rows** (W14-SV lands the dispatch; WR-SV answers; every command is audited):
  - `/dye <slot> <channel> <dye>` and `/bleach <slot>` on yourself;
  - `/give set <W15-x> [class] [sex]`;
  - `/grant reset <char> <id>` (tests only).
- **Client debug knobs** in the perf overlay: `tiers: t1 n / t2 m`, `cloth: sim n / µs`, `crowd batches n`.

---

## 4. Seams (step 0; six agents; every edit additive; the Low guard stays green)

All six start from the final commit of wave 12 + the mini-wave (D1) and re-read every file they touch. With the new
content empty, the cloth setting off and the tiers stubbed to "everyone full", the client's frames, the export and the
server's saves are byte-identical to the start commit (each agent has a test for it).

### 4.1 W14-SH: the wire and shared content (one agent; S, 0.75 day)

§3.1 in one commit, plus PROTOCOL.md.

**Tests:**

- every new request and event round-trips through the validators;
- unknown fields are dropped;
- the `dyes` and `itemDye` bounds hold;
- an old frame without the new fields parses unchanged;
- `EQUIP_SLOTS` keeps every old index.

### 4.2 W14-AP: the appearance package (one agent; S, 0.5 day)

D4.

**Tests:**

- `composeEquipment` with no new fields equals today's plan, byte for byte;
- a worn costume hides the six armour slots and keeps the weapon and shield;
- `costumeHat` replaces the head piece;
- `BoundItem.cloth` and `.dye` are carried through;
- the viewer and converter test suites stay green.

### 4.3 W14-SV: the server spine (one agent; S, 0.75 day)

D10, D13, D27, D33:

- migration 11;
- the `char_grants` helper (`grantOnce(char, id, fn)`);
- the loot-chain provider slot (`wardrobeDrops`, inert while `content/wardrobe/drops.json` is absent);
- the GM rows as stubs that answer "not built yet";
- the dry-run script skeleton;
- the `millet-fields` row.

**Tests:**

- migration 10 → 11 on a temp copy keeps every row;
- `grantOnce` runs once across two logins;
- with no wardrobe content, the loot rolls equal today's for a fixed seed;
- the places tool accepts the new row;
- the whole server suite.

### 4.4 W14-CV: the converter spine (one agent; M, 1.75 days)

D6, D12, D21's hook:

- the manifest fields;
- the `cloth` and `crowd` verb lines (stubs);
- the new-set hook in the equipment export;
- `data/authored.ts` with its lines in `data/items.ts` and `data/shops.ts`;
- the `town/vat.ts` joint-override hook (`bakeVat(..., { jointOverride? })`, a no-op by default);
- the optimize-out entries for `crowd/` and `*.cloth.glb`.

**Tests:**

- the export is byte-identical with the new inputs empty (G7);
- an authored item colliding with a retail code is an error, and so is a missing model or icon;
- old manifests validate;
- `bakeVat` without an override equals today's bytes (the TL-V test).

### 4.5 W14-WR: the world-render spine (one agent; S, 1 day)

D5 (runtime), D7, D9:

- move the townsfolk's shared VAT pieces to `world-render/src/crowd/` (no behaviour change);
- `ShadowCasterSource.cascades?`;
- `pbr/dye-plugin.ts` as a skeleton at `CUSTOM_FRAGMENT_UPDATE_ALBEDO` priority 240, plus the `sroDyeApply` snippet
  in GLSL and WGSL (inert without `SRO_DYE`);
- the actor decoration and warm-up registrations;
- the `material-budgets.test.ts` row skeletons.

**Tests:**

- the townsfolk suites and the `seams-classic` and Low-guard files stay green;
- a caster source without `cascades` behaves as today;
- the plugin compiles in both languages with the surface plugin on, and an undyed material carries no define;
- the material-budget rows pass.

### 4.6 W14-G: the game spine (one agent; M, 1.25 days)

D3, D8, D11, D16's constants:

- in `models.ts`:
  - `tier`, `toCrowd()` and `toFull()` as stubs;
  - the `ClipClock` interface;
  - lazy animation groups behind `group(name)`;
  - the cloth hooks;
  - `swapWorn` (complete);
  - the `dress()` cloth pick;
  - the `setDyes` hook;
- `crowd-budget.ts`: `tierOf` (everyone T1-or-own until CP-A) and the per-preset and Apple counts;
- `settings.ts`: `ClothSetting` and `clothFor`;
- the Options row, the i18n files and the feature registrations;
- the mock server's `dyes` and costume fields.

**Tests:**

- the whole `apps/game` suite;
- the actor's draw list and frame are byte-identical with the stubs;
- `swapWorn` replaces one garment with no leak;
- lazy groups play the same clip as eager groups (a replay of the bench set);
- `clothFor` follows `townLifeFor`'s table, with Low off.

---

## 5. The order: foundation first

### 5.1 Step order and concurrency

```
(now)      wave 12 + the mini-wave finish (G5 fix, verify, deploy)
pre-start  NEW FILES ONLY, scratch outputs (work/tmp/w14-*), no shared file, no work/out writes:
           CL-S cloth-sim.ts (pure) + the edge collision + the re-rendered GIF
           CL-R cloth-rig.ts against a scratch export; WR-MASK the proposer; WR-CV npc-outfit.ts re-bind in scratch
           WR-ART-* Blender kitbash + the pilot Meshy set atlas (D31) -> work/tmp/w14-art/
renumber   the lead's docs-only commit (§15)
step 0:    W14-SH | W14-AP | W14-SV | W14-CV | W14-WR | W14-G                      -- from the wave-12 final commit
step 1:    FOUNDATION:  CP-V | CP-R  ->  CP-A (CP-S cuts first)  ->  CP-L
           off-frame, in parallel (no frame cost; merge after their own tests):
                        CL-R (into the real converter) | CL-S | WR-MASK | WR-SV | WR-D (rows, icons)
                        WR-CV (converter, scratch outputs until X2) | WR-ART-* (art in scratch)
           -- checkpoint X1: convert + crowd + optimize; THE FOUNDATION GATE (§6.4): plaza <= 12, fights <= 13 ms
              WebGPU Medium, <= 9 / <= 10 WebGL2, quiet machine. Red -> foundation fixers first, nothing below merges --
step 2:    in this merge order:
           a. cloth:     CL-G -> CL-L (LAB-CL1 on the foundation) -> CL-W            (D23: Medium Near if CL1 fails)
           b. civilian:  WR-CV (variants into work/out) + WR-ART-CIV rows; CL-V (the baked back chain)
           c. armour:    WR-ART-B -> WR-ART-A -> WR-ART-CDE (their rigs.json rows, sets, atlases)
           d. dyes:      WR-R (plugin, palette, dyed clones, the T2 snippet in CP-R's plugin) -> WR-UI
           review renders on the GPU queue (turnarounds, the crowd sheet, the cloth clips)
           -- checkpoint X2: the full chain of D6 + full optimize --
step 3:    I-14 -> LAB-14 -> H-14 -> F-14 (-> X3) -> G-14 -> V-14 -> deploy (standing rule, D32)
```

**Critical path** [projected: `budget.py`]: step 0 ≈ 1.75 days in parallel → CP-R (4) alongside CP-V (3.25) → CP-A
(4) → X1 and the gate (1) → CL-G (2.5) → the X2 chain (1) → I-14 (1.5) → LAB-14 (2) → H-14 (1.5) → F-14 (2) → G-14
(1) → V-14 (1). That is **≈ 23 working days**. The art lanes (≈ 16.5 agent-days) run in parallel from the pre-start
and stay off the path unless the pilot atlas fails (R: atlas packing).

### 5.2 Why this order

- **The foundation first** (the task; CHAR_PERF D20; CLOTH CL-D14; WARDROBE §13). Every later item's frame cost is
  measured **on top of** the tiers, and cloth's Medium gate only makes sense there.
- **Then cloth.** Cloth needs the tier ranking (D14) and the T1 skeletons; the user's "garmet" is its first check.
- **Then the civilian clothes.** They touch the townsfolk's VAT path, not the player tiers, so they come next in risk.
- **Then the armour sets.** They need CL-R's `rigs.json` and the X1 crowd meshes in their layout.
- **Then the dyes.** The dyes need the masks of every new piece and variant, and their T2 path lives in CP-R's
  plugin.
- The server and content rows (WR-SV, WR-D) have no frame cost and run in step 1, so step 2 integrates against real
  items.

---

## 6. Budgets

### 6.1 What the wave adds per preset

| Preset | Foundation | Cloth | Civilian townsfolk | Sets and costumes | Dyes |
|---|---|---|---|---|---|
| Low (Classic) | nothing (today's code path) | off, no module | no crowd (as today) | 256² atlas tier; 6 draws like retail; costumes −4/−5 | the plugin on dyed clones only |
| **Medium** | T1 4 (2 in a crowd fight on Apple/iGPU); T2 everyone else; cascade 0 + blobs | 5 sims (Apple/iGPU 3) | 10 variants × 8 colourways, baked back chain; draws unchanged | T1 6 draws a set; T2 inside the outfit batch | ≤ 0.05 ms GPU at 20 dyed players; 0 CPU |
| High / Ultra | T1 6 / 12 (4, then 2 in a crowd fight); T2 cascades 0–1 / all | 7 / 13 sims; wind | 14 / 18 variants | as Medium | as Medium |

### 6.2 Client G1 with margin [projected: `work/tmp/w14w-plan/budget.py`; dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome, 1080p, p95; "today" = CHAR_PERF's busy-machine runs × 0.62 (WebGPU) / × 0.53 (WebGL2)]

| Scene (20 players unless named) | Today | Foundation (CHAR_PERF §10.1) | **+ cloth + dyes + new outfits** | Gate row (D35) | G1 line |
|---|---|---|---|---|---|
| **WebGPU Medium plaza** | ≈ 13.6 (the mini-wave gate measured 12.7) | 9.5–10.5 | **9.7–10.9** | **≤ 12.0** | 16.7 |
| **WebGPU Medium Tiger Girl, first fight (5906)** | ≈ 17.1 | 10.4–11.5 | **10.6–11.9** | **≤ 13.0** | 16.7 |
| **WebGPU Medium Tiger Girl, second fight (5659)** | ≈ 15.2 | 10.4–11.5 | **10.6–11.9** | **≤ 13.0** | 16.7 |
| WebGPU Medium plaza, every bot in a different outfit (dresser) | — | 8.9–10.5 (`unique1` + T1) | **9.1–10.9** | ≤ 12.5 | 16.7 |
| **WebGL2 Medium plaza** | ≈ 8.4 (gate) | 6.5–7.5 | **6.7–7.9** | **≤ 9.0** | 16.7 |
| **WebGL2 Medium Tiger Girl** | ≈ 9.2 | 6.8–7.8 | **7.0–8.2** | **≤ 10.0** | 16.7 |
| WebGPU High plaza (G2, reported) | ≈ 17.3 | 12.9 | **13.3–13.4** | ≤ 14.0 | — |
| WebGPU High fight (G2; D15 step 2, T1 2) | ≈ 21.0 | ≈ 15.1 | **≈ 15.3** | ≤ 16.0 | — |
| WebGL2 High plaza (G2) | 8.2 (wave 11), 14.2 (LAB-12, 1 run) | ≈ 11 [unknown] | ≈ 11.5 [unknown] | ≤ 12.0 | — |
| Every other LAB scene (empty plaza, market, fields, beach, …) | as G-12 | unchanged (± 0.3) | + ≤ 0.2 | G3 | 16.7 |

What this means:

- **Margin.** Every Medium 20-player cell projects at least 1.1 ms under its gate row and 4.8 ms under the G1 line on
  the dev PC.
- **The cloth and dye share** is ≈ 0.2–0.4 ms. The cloth figure is CLOTH §7's, and the dyes are GPU only.
- **The new outfits add no draw.** New outfits in the townsfolk crowd keep one draw per variant. In T2, twenty
  different outfits cost one draw each, and the dresser row measures that.
- **The projections reuse a factor measured on a busy machine** (CHAR_PERF §1, R8). **LAB-14 measures on a quiet
  machine**, and the gate rows decide.
- **The new art also costs memory and download, not frame time** (§6.5).

### 6.3 Vendors

- **AMD (the dev PC):** every number above.
- **NVIDIA:** not measured [unknown]. Nothing in the T2 shader, the dye snippet or the sim is vendor-specific; the
  frame is CPU-bound (GPU 1.7–2.8 ms of a 15–28 ms frame [confirmed: CHAR_PERF §1]).
- **Apple (M1+):** the CPU is the question. An M1's single thread is ≈ 0.7× the dev PC's [likely]. That puts the
  Medium plaza at ≈ 13.9–15.6 ms and the fight at **≈ 15.1–17.0 ms with the whole wave and no Apple rule**, which can
  cross G1 (P4). **D16** brings the fight to ≈ 14.2–16.1 ms [projected]. Apple's GPU pays more for vertex texture
  fetches: `'nearest'` beyond 25 m, and Q4's blob fallback if cascade-0 casters cost > 0.3 ms there.
  **N1** (a friend's one-minute LAB page) is the only real check before the performance pass.
- **Laptops** (CPU ×1.5–2, BATCHING F20): cloth on Medium costs +0.33–0.7 ms. The `'near'` Options value is one
  click; the defaults are not changed this wave (the final performance pass tunes per-machine defaults).

### 6.4 The foundation gate (at X1) and LAB-14 method

**The foundation gate (X1; CP-L's rows; the lead runs it):**

- Setup: the production bundle on a private `vite preview` (a free port, stopped after) and a private server on a
  **temp copy** of `work/server/game.db` (the wave-11 harness plus CHAR_PERF's tools, 20 bots), 1920 × 1080 at DPR 1,
  a 60 Hz timer pump.
- Runs: 400 uncapped frames after streaming idles, **3 runs, median p95**, the GPU lock held, a quiet machine (CPU
  < 15 % for 30 s), one browser tab, closed after.
- Rows: the plaza, both fights and the dresser plaza, on WebGPU and WebGL2 Medium and WebGPU High.
- Pass: §6.2's foundation targets (≤ 12 / ≤ 13 / ≤ 12.5 on WebGPU Medium; ≤ 9 / ≤ 10 on WebGL2). On red, the CP lanes
  fix it before step 2 merges anything that costs frame time; after 2 days of red, I-14 brings the numbers to the cut
  list (§9).

**LAB-14** (step 3) re-runs the foundation rows with everything on, plus these:

1. **LAB-CP rows:** the plaza and both fights, in the starter outfit **and** dressed (D35), Medium on both backends,
   then High. Also the walk-through with the hitch watchdog: promotions T2 → T1 at the 20 m edge with no frame
   > 33 ms, the first dyed stranger with no shader compile, the first T2 character of each weapon family with no
   compile and the lazy VAT loaded.
2. **LAB-CL1–5** (CLOTH §10):
   - CL1: cloth Auto vs Off on the dressed plaza (everyone within 15 m), the gate ≤ 0.35 ms CPU p95;
   - CL2: High and Ultra;
   - CL3: the 144 Hz / 7 ms frame cloth-to-body gap ≤ 1 cm;
   - CL4: the Tiger Girl fight;
   - CL5: Low byte-identical.
3. **WR-LAB rows** (WARDROBE §8.3): the plaza with 20 dyed players in new sets, Wardrobe on − off ≤ 0.2 ms on High;
   the townsfolk at noon and at dusk with the new variants (draws unchanged); the market street.
4. **The LAB-12 list re-run** (G3).
5. **Memory after 10 minutes of the dressed plaza:** VRAM within §6.5's budgets; no growth over 10 MB between minute
   5 and minute 10 (the outfit cache and dyed clones release).

The results go to `work/tmp/w14-lab/budgets.md` and to Dropbox `wave14/budgets.md`.

### 6.5 Memory, download, server [projected unless tagged]

- **VRAM:**
  - crowd VATs ≤ 40 MB (a solo session holds 2–4 at 10–20 MB; a 20-friend town up to 8 at ≈ 35 MB);
  - crowd arrays ≤ 40 MB (256² albedo ≈ 16.5, 512² atlases ≈ 6.3, masks ≈ 12);
  - set atlases 1.4 MB + mask 0.35 MB per worn set;
  - cloth ≈ 1 KB of state per sim actor, plus 100–200 KB per cloth glb loaded.
- **Download and disk:**
  - the new sets, masks and civilian variants: +45–55 MB (WARDROBE §8.2), the sets loaded on demand;
  - VATs ≈ 2–4 MB each after Brotli, lazy;
  - arrays ≈ 20–35 MB, lazy per gender;
  - cloth glbs +2–4 MB;
  - **≈ +90–125 MB on the server's disk** in all, of which a player downloads what they meet.
- **Server:** one integer per item row; `char_grants` holds a few rows per character; ≈ 180 B per fully dyed player
  in spawn and `appearance` messages (on change only). The N100's tick is unchanged: dyeing is a request per click.

### 6.6 The gates

- **G1 (with margin):** the gate rows of §6.2 (≤ 12 / ≤ 13 / ≤ 12.5 WebGPU Medium, ≤ 9 / ≤ 10 WebGL2), with
  everything on, both dressings. Every other LAB scene passes G1 (< 16.7).
- **G2:** High as §6.2 (plaza ≤ 14, fight ≤ 16 with D15); WebGL2 High reported; Wardrobe on − off ≤ 0.2 ms on High
  (dyes, new outfits).
- **G3:** no existing scene slower than G-12 by more than 0.2 ms (Medium) or 0.3 ms (High).
- **G4:**
  - the Low guard (undyed Low byte-identical, no cloth module, no tiers);
  - `material-budgets.test.ts` (player crowd ≤ 16 units and ≤ 16 inter-stage; the actor and crowd sets with
    `SRO_DYE`);
  - ≤ 8 vertex buffers on WebGPU and ≤ 16 attributes on WebGL2 for the crowd pipeline;
  - 0 WebGPU validation errors;
  - no compile on the first dyed stranger, the first T2 of a family, the first promotion or the first cloth actor;
  - 0 allocations per frame in the crowd renderer, the clip clock, the cloth sim and the dye path;
  - allocation ≤ 0.2 MB a frame at the plaza and ≤ 0.3 MB in the fight.
- **G5 (look):**
  - the plaza with friends (nobody snaps, slides or floats);
  - the turnaround sheet of each set (undyed + two dyes);
  - the crowd at noon and at dusk ("still copy-pasted?");
  - the cloth clips (your own character in `clothes_03` and in a new robe);
  - the default ships if the user does not answer.
- **G7 (data):**
  - the export byte-identical with the new inputs empty;
  - X1/X2's checks (D28);
  - migration 10 → 11 keeps every row;
  - every new item has an icon, a crowd mesh and a mask that matches its bitmask.
- **G8 (authority):** WR-SV's refusals (every `itemDye` failure, dyes kept through trade, storage, stalls and alchemy,
  costumes never add stats, the grant once).

**What blocks:**

- A **perf-only** miss (G1 margin rows, G2, G3, a vendor projection) is first handled by the cheap levers (D15, D16,
  cloth Near). If it still misses, **it deploys** under the standing rule and is reported (D32), and the scope-cut
  order (§9) is applied in the next fix pass.
- **G4, G7 and G8 block** the deploy until fixed or cut.
- **G5** blocks only its item, and only until the user answers (the default ships).

---

## 7. Lanes

### 7.1 The GPU queue

| Slot | When | Job (owner, label) | Length |
|---|---|---|---|
| Q0 | pre-start / step 1 | the cloth GIF re-render (CL-S, CPU only, no lock); the pilot set atlas review in the viewer (WR-ART-B) | ≈ 20 min |
| Q1 | X1 | **the foundation gate** (§6.4) | ≈ 2 h |
| Q2 | step 2 | review renders: cloth clips (CL-L), the crowd at noon and dusk (WR-ART-CIV), turnarounds (WR-ART-*), a dyed piece (WR-R) | ≈ 20 min each |
| Q3 | step 3 | LAB-14 | ≈ 3.5 h |
| Q4 | step 3 | G-14, then V-14's three cells | ≈ 2 h + 20 min |

Bench slots pre-empt everything not yet started; no wave-14 slot runs while wave 12 holds the lock.

### 7.2 The lanes

Effort is in agent-days. Every lane re-reads its files at the start commit and owns only the files listed.

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **CP-V** crowd export | `packages/convert/src/crowd/{vat-sets, sockets, crowd-mesh, texture-array}.ts`, the `crowd` verb body, the `crowd/` export | W14-CV; texpipe's KTX2 encoder; WR-MASK's masks and WR-CV's set atlases at X2 | CHAR_PERF §13.2: per VAT a row within 1 mm (float32) / 3 mm (half) of the skinned pose, ≤ 4,096 rows, ≤ 6 MB; sockets (the saddle included); every item and body part (cloth garments from the **plain** glb) has a crowd mesh in the one layout, both windings for double-sided, the layer index, array bit and **equipment slot** (D17) right; array layers match the albedo (mean colour within 2 %); budgets; deterministic | the arrays' contact sheet | 3.25 |
| **CP-R** crowd renderer | `packages/world-render/src/crowd/{batch, outfit, skin-plugin, instances}.ts`, the dye table texture, the warm-up entries | W14-WR (folder, `cascades`, the dye snippet) | NullEngine: draws = distinct outfits + models; outfit reuse; one instance write per character; no allocation per frame; stable slots and `thinInstancePartialBufferUpdate`; both languages compile; ≤ 8 buffers / ≤ 16 attributes; the "player crowd" material-budgets row; the LAB pixel test (≤ 1 px at 1080p vs the skinned pose, both backends, shadow too); **a dyed T2 piece equals the T1 dyed piece within 2 % mean colour** (D7, D17) | — | 4 |
| **CP-A** actor tiers (+ CP-S) | `apps/game/src/three/{models, crowd-actor}.ts`, `world/crowd-budget.ts`, `world/entities.ts` (label anchor, throttle, 15 Hz far labels, no string per frame) | W14-G, CP-R, CP-V | CHAR_PERF §13.2: own T0; target and hover always T1; party within the cap (a party of 8 on Medium: ≤ 4 T1); counts per preset **incl. D15 and D16**; hysteresis; ≤ 2 promotions a frame; the same pose at promotion (1 mm); the root never disabled (an NPC's pick box picks; a root aura draws); a rider within 1 cm of the saddle; the clip clock fires the same events as Babylon's groups over the bench set; CP-S's unit tests (blending over started groups, frozen T1 materials unfrozen one frame on a dye/fade/highlight); Low has no tiers | the plaza with 20 friends: nobody snaps, slides or floats | 4 |
| **CP-L** LAB rows | `work/` scripts only: LAB-CP (the harness as the gate's), **the dresser** (random retail + W15 sets + costumes + random dyes, D35), the Apple-rule switch for N1's page | all | §6.2's rows; the dresser is deterministic per seed | — | 0.5 |
| **CL-R** rig + export | `packages/convert/src/equipment/cloth-rig.ts`, `content/cloth/{rigs, tunes}.json`, the `cloth` verb body | W14-CV (verb, manifest `model.cloth`) | CLOTH §15.2: ≤ 4 influences summing to 1; pinned and above-band vertices byte-identical; bind within 1 mm; no dead chain; first 43/45 joints equal; deterministic; the 20 in-game meshes rig; the robe's `owner`/`uses` pair; the rig block round-trips in the glb extras | the `--sheet` review image | 1.5 |
| **CL-S** sim | `apps/game/src/three/cloth-sim.ts` (+ test) | none | determinism (600 ticks twice); settles in 2 s; **no particle and no ring/vertical edge inside a leg or foot capsule** (a calf swept between two hem chains); tether; teleport reset; no NaN; no allocation per tick; the re-rendered GIF (no shin through the surface) | the re-rendered GIF | 1.5 |
| **CL-G** game | `apps/game/src/three/cloth.ts` (`ClothSystem`), the Options row text, the perf counter | W14-G (hooks, `swapWorn`, `tierOf`, `clothFor`), W14-AP (`BoundItem.cloth`) | NullEngine: **sims = T0 + T1 wearers of a cloth glb, per preset incl. D15/D16**; no warm actors; the cloth glb picked at promotion, the plain one in T2; Near mode = you + party; one sim for a robe's two items; a `uses` item with another set's leg item loads its plain glb; Volume 0/4 keeps the bind outside the body; Low loads no cloth glb and no module; live Off ↔ Auto leaves nothing; no allocation per frame; the deviation render's gap ≤ 1 cm at a 7 ms frame | your character in `clothes_03`, run and jump; Off vs Auto | 2.5 |
| **CL-L** LAB + tuning | the LAB-CL1–5 rows in LAB-14, `content/cloth/tunes.json` values | GPU queue | LAB-CL1–5 (§6.4) | before/after clips per tune | 1 |
| **CL-W** wind + hats/sleeves | the wind term in `cloth.ts` (by CL-G's API), `rigs.json` rows for hats and sleeves | CL-G | wind off = a byte-identical step | — | 0.5 |
| **CL-V** townsfolk baked chain (D21) | `packages/convert/src/town/cloth-bake.ts` (fills W14-CV's `jointOverride` hook with CL-S's step run offline over each loop) | W14-CV, CL-S, WR-ART-CIV's weights | the VAT within 1 / 3 mm for the body joints; the chain joints loop seamlessly (first = last frame within 1 mm); **VAT bytes unchanged**; ≤ 2.5 MB | the plaza crowd in robes | 1 |
| **CL-B** Blender fix-up | `pnpm sro cloth --blend`, `content/cloth/overrides/` | CL-R | the round trip keeps the weights rule | — | 0.5 |
| **WR-CV** converter | `packages/convert/src/town/{variants, npc-outfit}.ts`, `equipment/sets.ts`, `town-wardrobe-check` | W14-CV, W14-AP | WARDROBE §13: the blacksmith re-bind equals the prototype within 0.1 mm; IBM check; joint stretch ≤ 2×; `Bip02` alias; `keepHead`; no player glb/texture in any variant and no crowd glb/texture in any costume; every mask matches its bitmask; TL-V budgets incl. VAT ≤ 2.5 MB; **equal vertex layouts per set** | the crowd sheet | 3.5 |
| **WR-MASK** masks | `packages/texpipe/src/wardrobe-masks.ts`, `content/wardrobe/masks.json`, review sheets under `work/` | — | deterministic clusters; every listed texture has a mask; channel coverage reported; half-size RGB + per-channel mean luminances | the mask sheets (optional) | 1.5 |
| **WR-ART-CIV** civilian art | `packages/convert/tools/blender/wardrobe/*.py` (hats, aprons, sashes, bags, farmer clothes; the `cloak01–04` back-chain weights), `content/wardrobe/town.json`, S3 retexture packs | WR-CV, WR-MASK, CL-V, Meshy ≤ 100 | each outfit converts, ≤ 2,500 triangles, both skeletons; turnaround | the crowd at noon and dusk | 4 |
| **WR-ART-A** Terracotta Regalia | its Blender scripts, packs, `content/wardrobe/sets/w15a.json`, its `rigs.json` rows | WR-CV, WR-MASK, CL-R, Meshy ≤ 120 | binds on its skeleton; one material per set; `pnpm sro cloth` passes its rows; Volume 0/4 (D24) | turnaround | 5 |
| **WR-ART-B** Tiger-Hunter's | as A, `sets/w15b.json` (the pelt tail row) | as A, ≤ 120 | as A | turnaround | 4 |
| **WR-ART-CDE** costumes | W15-C, D, E (costume pieces + hats), `sets/w15{c,d,e}.json` (the straw cape on `cloak01–04`, CLOTH `cape`) | as A, ≤ 110 | as A; the costume rule draws no armour; each W15-E carries its own silhouette element | turnaround | 3.5 |
| **WR-R** dye runtime | `packages/world-render/src/pbr/dye-plugin.ts` (full, incl. the `sroDyeApply` snippet), `town/crowd.ts` (the palette path), `apps/game/src/three/dye-materials.ts` (new; via W14-G's hook) | W14-WR, W14-G, CP-R (includes the snippet) | shader parity (GLSL/WGSL keys; the full-size-A comparison, WARDROBE D31); wet darkening applies to dyed cloth (priority 240 < 250); a dyed and an undyed part never share a material; dyed clones release on undress; 0 allocations per frame; undyed Low byte-identical; no compile on the first dyed stranger | dye a piece | 2.5 |
| **WR-SV** server | `apps/server/src/wardrobe.ts`, Mrs Jang's Dyes and Tailor tab rows' behaviour, interim drops via the overlay, JG_002's reward + `grantOnce`, the GM rows' bodies | W14-SV, W14-SH | every refusal; dyes kept through trade, storage, stalls and alchemy; costumes add no stats; the grant once | — | 2 |
| **WR-D** content | `content/items/wardrobe.json` (88 pieces, stats from CLIMB's budgets, `enabled` per §10), `content/wardrobe/{dyes, drops}.json`, `content/shops/wardrobe.json`, the 113 icons (`tools/blender/wardrobe/icons.py`) | W14-CV (merge) | content check; stats equal the referenced rows; every item has an icon | — | 2 |
| **WR-UI** client | `apps/game/src/hud/dye.ts`, the Tailor tab and the try-on mirror in `hud/shop.ts`, tooltips in `hud/items.ts`, `i18n/en-wardrobe.ts` | W14-G, WR-R | the mock server; the preview never sends and reverts on close; apply consumes one dye; the mirror loads on demand and tells the server nothing | dye, try on | 2 |

**Totals** [projected: `budget.py`]:

| Group | Agent-days |
|---|---|
| step 0 | 6 |
| foundation | 11.75 |
| cloth | 8.5 |
| wardrobe | 30, of which art 16.5 |
| X1–X3, I-14, LAB-14, H-14, F-14, G-14, V-14 | 9.5 |
| **Total** | **≈ 66** |

Most of it runs in parallel lanes. The specs summed to ≈ 13 + 9 + 34.5. This plan removes the duplicate seams and
WR-LAB (folded into LAB-14), adds integration to verify, and makes CL-V smaller (D21).

### 7.3 Seams each lane may not cross

- After step 0, no lane edits the W14-* files:
  - `packages/shared/src/{protocol, validate, content, content-check, index}.ts`;
  - `packages/appearance/src/{manifest, compose}.ts`;
  - `apps/server/src/db.ts` and the loot-chain slot in `gameplay.ts`;
  - `packages/convert/src/{cli, data/authored, data/items, data/shops, equipment/manifest}.ts` and the export hook
    lines;
  - `packages/world-render/src/render/shadows.ts`;
  - `apps/game/src/{settings, hud/options}.ts`.

  `models.ts` (CP-A only), `crowd-budget.ts` (CP-A), `town/vat.ts` (frozen; CL-V uses the hook) and `town/crowd.ts`
  (WR-R) follow D3 and D5. A lane that needs more asks I-14, which adds the seam in its own commit.
- **One owner per shared module** after step 0:
  - `three/models.ts`, `world/crowd-budget.ts`, `world/entities.ts`: **CP-A**;
  - `world-render/src/crowd/**`: **CP-R**;
  - `pbr/dye-plugin.ts` and `town/crowd.ts`: **WR-R**;
  - `town/variants.ts`, `town/npc-outfit.ts`, `equipment/sets.ts`: **WR-CV**;
  - `equipment/cloth-rig.ts` and `content/cloth/` (format): **CL-R**;
  - `convert/src/crowd/**`: **CP-V**;
  - `apps/server/src/wardrobe.ts`: **WR-SV**;
  - `content/items/wardrobe.json` and `content/wardrobe/{dyes, drops}.json`: **WR-D**;
  - `content/wardrobe/town.json` rows: **WR-ART-CIV**;
  - each `content/wardrobe/sets/*.json` and its `rigs.json` rows: its art lane.
- **Nobody edits** `pbr/foliage-plugin.ts` or `pbr/surface-plugin.ts` (D7).
- No lane writes `work/out/` outside the convert lock. No lane starts or stops the user's dev servers (:5180, :7000,
  :5173); private servers run on free ports with temp DB copies only. At most one browser tab per lane, closed when
  done. Every timing runs under the GPU lock.

### 7.4 Merge order and checkpoints (I-14)

1. **Step 0:** W14-SH → W14-AP → W14-CV → W14-SV → W14-WR → W14-G. Then the suite, typecheck and the Low guard; record
   the test count.
2. **Step 1:**
   - Foundation: CP-V → CP-R → CP-A (CP-S commits first) → CP-L.
   - Off-frame, in any order after their tests: CL-S, CL-R, WR-MASK, WR-SV, WR-D (rows, icons).
   - Then **X1 + the foundation gate**.
3. **Step 2:**
   - a. Cloth: CL-G → CL-L → CL-W.
   - b. Civilian: WR-CV → WR-ART-CIV → CL-V.
   - c. Armour: WR-ART-B → WR-ART-A → WR-ART-CDE.
   - d. Dyes: WR-R → WR-UI.
   - Then **X2**.
4. After every merge: the Low guard and typecheck; `material-budgets.test.ts` if a material or define changed; the X1
   rows on the GPU queue after a, c and d (a quick single run, so a regression is caught where it lands).

### 7.5 Cross-feature tests I-14 adds

- **A dyed robe through every tier:** a level-16 player in the W15-A garment robe with three dyes walks from 30 m (T2:
  the outfit batch, the dye row, the plain glb, blob beyond cascade 0) to 10 m (T1: promotion with the same pose,
  the cloth glb, the sim starts at its targets, the dyed clone) and back. The colours stay equal within 2 %, the
  pose within 1 mm at the swap, and no frame exceeds 33 ms.
- **A party of 8 in robes on Medium:** ≤ 4 T1, ≤ 5 cloth sims; on an Apple flag in a crowd fight, ≤ 2 T1 and ≤ 3 sims.
- **A rider in a robe:** T1 the robe simulates over the saddle; T2 the rider rides the socket within 1 cm.
- **Costumes:** a costume wearer in T1 draws body + hair + costume (+ hat) + weapon; in T2 one outfit batch; dyed
  costume channels survive trade.
- **The townsfolk:** no variant uses a player glb or texture; no costume uses a crowd one; at the plaza, no two
  agents within 12 m share variant and colourway; the baked back chain loops.
- **Volume 0 and 4:** a T2 player, a T1 player in a cloth robe, a new set piece: no body through the cloth (1 cm).
- **Low:** a dyed player shows its dyes; an undyed one is byte-identical; no cloth module, no tiers.
- **Empty content:** with every new content folder empty and cloth off, the export and the server equal the start
  commit's (G7).

### 7.6 I-14: integration checklist (the lead)

1. The renumber commit (§15) before step 0.
2. Merge per §7.4; the suite, typecheck and Low guard after each.
3. X1 with the foundation gate, X2, X3 if needed (D28).
4. A scripted play-through on a private server (temp DB copy):
   - a new character in the starter clothes does JG_002 and gets W15-D;
   - an old character that finished it gets W15-D once at login;
   - buy dyes and a Tailor costume;
   - dye, bleach and trade a dyed piece;
   - a GM jump to 16 for Tiger Girl with 19 bots (a W15-B drop);
   - walk the market at noon and at dusk.
5. Two browser clients (WebGPU and `?engine=webgl`) at the plaza with the dressed bots.
6. LAB-14 (§6.4).
7. Shots for the user in Dropbox `wave14/`: before and after the plaza with friends; the cloth clips (`clothes_03`
   and a new robe); the crowd at noon and at dusk; each set's turnaround undyed and with two dyes; the Dye window; the
   Tailor mirror.
8. Docs:
   - RENDER.md: the tiers, the crowd renderer, the shared dye snippet;
   - CHARACTER_SCALE.md: Volume in T2 and cloth;
   - TOWN_LIFE.md: the civilian variants, the colourways, the baked back chain;
   - SYSTEMS_COMBAT.md: the costume slots, dyes on items;
   - ASSETS.md: the `crowd/` and `*.cloth.glb` exports, set atlases, masks;
   - UI.md: the Cloth row, the Dye window, the Tailor tab;
   - PROTOCOL.md (W14-SH);
   - DEPLOY.md: migration 11, the dry run;
   - PLAYTEST.md: §12's checks and `millet-fields`;
   - BACKLOG item 9: mark the character half done, the rest is the performance pass;
   - each spec's status;
   - mark the passages this plan overrides (D14, D15, D16, D17, D18, D21, D27, D32).
9. Scratch: keep every image the user reviewed (D38).

### 7.7 H-14: the hunt (read-only; findings become tests, then F-14 fixes)

The specs' own lenses stand (CHAR_PERF R1–R12, CLOTH §15.3, WARDROBE §15). H-14 runs these with every item on, each
by a separate agent or pass:

1. **Pops at the tier swap:** promotion and demotion at the 20 m edge while running, jumping, casting, dying, mid-
   crossfade, mid-arm-layer; a target picked from 40 m away; hover flicker on a crowd.
2. **The clip clock:** every clip of the bench set and of each weapon family against Babylon's groups (end events,
   JUMP's take-off and landing, one-shots resuming the base clip, held last frames, the companion mirror).
3. **Things on bones in T2:** weapon trails, a glow on a hand, skill effects of others, a nemesis-style aura on the
   root, the NPC pick box, damage numbers' anchor.
4. **Riders:** mount and dismount in T2, a T1 rider on a T2 horse never happens, a horse dying under a T2 rider.
5. **Legs through robes:** run, jump, dodge, mounted, the 144 Hz and 30 fps frames, Volume 0 and 4, sitting and
   vendor poses (CLOTH §15.3).
6. **Cloth after a teleport, a GM warp, a re-dress, a tab switch, a promotion**: no explosion, no lag.
7. **A party of 8 in robes** at the 20 m edge: tier flicker, swap churn, the cap.
8. **Outfit-cache churn:** twenty players re-dressing every second; dyeing every second; memory after 10 minutes.
9. **Mixed sets:** a robe's leg item with another set's chest; a costume over a cloth robe; a costume hat over a
   tasselled helmet.
10. **Dye correctness:** wet darkening on dyed cloth; a dye on a channel the mask lacks; Bleach; a dyed piece on Low; a
    dyed and an undyed piece sharing a material; the T1 and T2 colours of one piece.
11. **Dye economy and authority:** dyeing a bagged or stalled piece; a dye consumed on a refused request; trading
    mid-dye; duplicate `itemDye` packets; a dye item in storage.
12. **Costumes:** stats from a costume, durability on a costume, a costume in the trade window, the costume rule with
    REPLACE slots.
13. **The townsfolk rule both ways:** a variant reusing a player texture after a content edit; a costume reusing a
    crowd glb; the same NPC's walking cousin in his own colours (row 0).
14. **Re-bind failures:** each of the 30 outfits on each of the 13 faces (collar, wrists); the beggar boy's stretch;
    Sansan's alias; M11's turban.
15. **Interim sources:** W15-B farmed off Tiger Girl by a level-1 alt, the JG_002 grant twice, the Tailor's prices at
    ×3 rates.
16. **Hitches:** the first T2 of each weapon family, the first dyed stranger, the first cloth actor, the first
    costume, entering town with 20 dressed players.
17. **Limits:** WebGPU's 8 vertex buffers, 16 inter-stage variables, WebGL2's 16 attributes, the 256-layer arrays,
    4,096 VAT rows.
18. **Allocation:** the crowd renderer, the clip clock, the cloth sim and the dye path at 0 a frame; the fight's
    effects pooled (CHAR_PERF §8.2).
19. **Low changed** by any item (the guard and a pixel diff of the plaza with nobody dyed).
20. **Protocol:** an old client on the new server for one move and one trade of a dyed item; every new message at its
    bounds.
21. **Deploy path:** the dry run, the backup, `crowd/` served with the right MIME and Brotli, the lazy VATs over a slow
    link.
22. **Vendors:** the Apple rule triggers on an Apple or iGPU flag; `'nearest'` is not used on the dev PC.

### 7.8 F-14, G-14, V-14

- **F-14:** one fixer per file set (the owning lane's files, or I-14 for seam files), each fix with the test H-14
  wrote. A fix that changes a frame cost is re-measured on its LAB-14 scene; one that changes an export runs X3.
- **G-14:** a re-bench of every §6.4 row on the final tree and export, on a quiet machine under the GPU lock.
  `budgets.md` gets the "final gate" numbers, and G1–G8 are judged.
- **V-14:** a fresh agent that built nothing in this wave:
  - re-reads this plan, the three specs and the diff;
  - checks each never-cut item and each decision of §2, and each file owner (`git log --stat` per lane);
  - re-runs the suite, typecheck and the export checks (G7);
  - re-derives three G-14 cells: the WebGPU Medium dressed plaza, the WebGL2 Medium fight and LAB-CL1;
  - plays §7.5 on a private server and checks the migration dry run on a copy of a schema-10 DB;
  - reports [confirmed] / [failed] per item.

  Under D32, a [failed] never-cut item **blocks the deploy unless the failure is frame time only**.

---

## 8. The data migration

- **What changes:** two columns (default 0 = undyed) and one table. Nothing is converted and nothing is lost.
- **One-time grant:** at the first login after the deploy, a character with JG_002 done receives the W15-D pieces of
  its sex into the bag, else into storage. If both are full, it is retried at each login with a line ("The Chef left
  you a farmer's smock and hat; make room in your bag"). `char_grants` records it once.
- **Proving it:**
  - W14-SV's test: a schema-10 temp copy with characters mid-quest, with JG_002 done, and with a full bag and storage;
    after login every row is identical except the new ones, and a second login changes nothing.
  - The deploy's dry run on a copy of the live DB prints the row counts before and after, and exits non-zero on any
    difference outside the new column and table (D32).
- **The live accounts' state is [unknown] here** (the live DB is on the mini PC); the dry run's printout is the first
  look.

---

## 9. Scope-cut order (cut from the top; one list for the wave) and never-cut

Each item names its spec's cut. Items marked **ask first** are cut only after telling the user. A cut that changes a
frame cost re-runs its LAB-14 row.

1. CL-B, the Blender fix-up (CLOTH cut 1).
2. CL-V, the townsfolk's baked back chain (CLOTH cut 2; the crowd's robes hang on retail weights).
3. Retail gear masks (WARDROBE D28: only new pieces and civilian outfits dye).
4. The try-on mirror (WARDROBE cut 2; the Tailor still sells).
5. Wind (CLOTH cut 3).
6. W15-E's third costume per sex (WARDROBE cut 3).
7. Sleeves and tassels (CLOTH cut 4).
8. S3 civilian retextures (WARDROBE cut 4; colourways still vary the crowd).
9. Tier-B short hems and short skirts (CLOTH cut 5).
10. One draw per T1 character (CHAR_PERF cut 1: already out of this wave).
11. The T2 upper-body layer (CHAR_PERF cut 2).
12. Row interpolation beyond 25 m on every preset (CHAR_PERF cut 3).
13. The chains of W15-E and W15-D (WARDROBE cut 5; W15-A's robes, the pelt tail and W15-C's cape keep theirs).
14. Matrix-write LOD and the 10 Hz far update (CHAR_PERF cut 4); far labels at 15 Hz (cut 5).
15. High and Ultra's extra crowd variants (WARDROBE cut 7).
16. T2 shadows on Medium (CHAR_PERF cut 6: blobs only, −0.25 ms).
17. The 512² atlas array (CHAR_PERF cut 6b; new sets read blurrier in T2).
18. Dyes on Low (WARDROBE cut 6; Low shows undyed, the server still stores dyes).
19. Lazy animation groups for T2 (CHAR_PERF cut 7).
20. NPCs in T2 (CHAR_PERF cut 8).
21. Other players' cloth sim (CLOTH cut 6: your own character only).
22. The garrison-uniform guards (WARDROBE cut 9).
23. **Ask first:** W15-A's garment class (WARDROBE cut 8; heavy and light stay).
24. **Ask first:** cloth on Medium (CLOTH cut 7: High and Ultra only; your own robe still swings on High).

If G1's margin rows still miss after the cuts that touch the frame (2, 5, 7, 9, 11, 12, 14, 16, 21), the D15/D16
levers apply on every vendor and the numbers go to the user. Under D32 the wave still deploys on a perf-only miss.

**Never cut:**

- **The perf foundation:**
  - the T2 crowd tier for other players and monsters;
  - **one draw per outfit**;
  - the crossfade;
  - the sockets (weapons in hands);
  - the seamless promotion;
  - the root kept enabled (picking);
  - the X1 foundation gate and G1 with margin.
- **Cloth on robes and skirts:**
  - the tier-A retail panels and the new garment robes **on your own character** at least;
  - the deviation rendering (no lag);
  - the edge-vs-capsule collision;
  - LAB-CL1;
  - Low off and byte-identical.
- **Civilian townsfolk clothes:**
  - no player gear on any townsperson, with the content check both ways;
  - the NPC re-binds;
  - the colourways;
  - no twins within 12 m.
- **Dyes:**
  - masks, the plugin and the one shared formula;
  - the Dye window;
  - the wire and migration 11;
  - dyes kept through trade;
  - dyes on new sets and civilian outfits.
- **New clothing:** W15-B and W15-D obtainable now; one material per set.
- **Everywhere:** the Low guard, G4, G7, G8, the migration without loss.

---

## 10. The named slots filled for The Climb (W15-A…E)

The Climb (wave 15) defined the slots in CLIMB §4.3 and WAVE_PLAN10 §10. **This wave builds their art and items**;
The Climb wires the sources it owns. Every row lives in `content/items/wardrobe.json` (WR-D). After the renumber,
CL-D's `content/climb/slots.json` **points at these item codes** instead of placeholder rows (§15).

| Slot | Name in play | Built now | Tier / level, stats | Obtainable in wave 14 | Wave 15 then adds |
|---|---|---|---|---|---|
| **W15-A** | **Terracotta Regalia** (CLIMB's row: "Tomb Warden's set"; D26) | heavy, light, garment × 2 sexes = 6 sets, 36 pieces; the garment robe's ring chain, the sash ends | T6–T7 / 18–20; = Seal of Star B per piece | **no** (`enabled: false`); the Tailor's try-on mirror previews it | TB-L's Regalia tokens + the Steward's exchange; the SoS set bonus |
| **W15-B** | **Tiger-Hunter's** | 6 sets, 36 pieces; the pelt tail; fur never dyed | T5 / 16; = 03_A per piece (no family bonus yet, WARDROBE F12) | **yes**: Tiger Girl one piece 20 %, the Tiger Mountains 0.3 % per kill | CLIMB's `drops.json` (B5, MB5) replaces the interim rows; S-SETS' family bonus |
| **W15-C** | **Ferryman's coat and hat** | costume + costumeHat × 2 sexes; the straw cape on `cloak01–04` | cosmetic | no; preview only | JG_X07 and the far bank's vendor |
| **W15-D** | **Millet Farmer's clothes** | costume + hat × 2 sexes; the smock hem ring | cosmetic | **yes**: JG_002 "Pests in the Millet" + the one-time grant | CL-Q keeps or moves the reward |
| **W15-E** (new) | **Tailor's costumes** | 3 per sex (+ one hat): 8 pieces | cosmetic | **yes**: Mrs Jang's Tailor tab, 40,000–120,000 gold | unchanged; The Climb's ×1 economy re-checks prices (WARDROBE Q2) |
| (dyes) | Storm Indigo, Gilt Bronze (Legendary) | rows | — | no (`enabled: false`) | the storm Qilin, the Tomb's last boss |

Wave 16 (Faces & Hair) gets one hook: the cloth system's tassel chain on `Bip01 Head` for hair (CLOTH Q1, ≈ 0.5 day).
Wave 17 (Arsenal) gets one: a weapon is a crowd part on a socket slot, and a family whose clips outgrow 4,096 rows
splits its skills into a second VAT (CHAR_PERF R3).

---

## 11. GM teleport places (the standing rule)

| Row | Group | Where | Why |
|---|---|---|---|
| **`millet-fields`** (new) | fields | snapped by the places tool near JG_002's `LOC_MILLET_FIELDS` (south of the walls) | the W15-D quest's mangyang; the farmer townsfolk; a user check |
| (existing) `plaza`, `market`, `smith`, `tiger-camp-1..11` | town, fields | — | the bench scenes, the crowd at noon and dusk, the re-bound smith's cousins, the W15-B interim drops |
| (existing command) `/tp npc jang` | — | Mrs Jang | the Dyes and Tailor tabs, the try-on mirror |

W14-SV adds the row, and the places tool snaps it on the X2 export (`pnpm --filter @sro/server places --write`).
PLAYTEST.md lists it.

---

## 12. What the user must provide or approve

**To start: nothing.** Every tool is installed, nothing is downloaded, and every item has a default.

1. **The preview sheet** `work/tmp/w14w-preview.png` (also in Dropbox as `wave14/wardrobe-preview.png`). It shows:
   - the perf before and after (the plaza and the fight, today against the crowd tier);
   - the measured and projected numbers;
   - the cloth GIF frames (today against the chains);
   - the civilian outfits;
   - the new armour with two dye swaps;
   - the six-colour crowd;
   - the budgets.

   **Default:** build as shown.
2. **Meshy for the art: ≤ 450 credits** (cap 600) of the 1,690 balance. **Default:** spend up to 450, stop at 600.
3. **The look per set** (a turnaround sheet each, undyed and with two dyes, during step 2), and **the cloth swing**
   (`work/tmp/cloth/cloth-proto.gif`; it plays about 10 % fast, and the shins poking through are fixed in CL-S, not a
   tuning question). **Default:** the art lane's pick and the prototype tunes ship if you do not answer.
4. **After the build, about 30 minutes of play** (PLAYTEST.md gets the list):
   - walk the plaza with friends: does anyone snap, slide or float when they come near?
   - a Tiger Girl fight with the group;
   - the market at noon and at dusk: does the crowd still look copy-pasted?
   - dye a piece, wear a Tailor's costume;
   - your character in a robe running and jumping, with Options → Cloth physics Off vs Auto.

   **Default:** the numbers stand.
5. **N1: one friend on an Apple Silicon Mac** (and one on NVIDIA if possible) opens the LAB page for a minute once the
   build lands. **Default:** the dev PC's numbers and the Apple rule (D16).
6. **N2: the stale `work/tmp/climb/climb.ts` process** (CHAR_PERF N2: one full core since 2026-10-02, The Climb's
   design run) keeps the machine from being quiet for the X1 gate and LAB-14. **May it be stopped before X1?**
   **Default:** the gate waits for a quiet window. If none comes within 2 hours, the lead stops only that process, as
   a recorded NIGHT_LOG note, since it is this pipeline's own finished design run.
7. **The deploy** follows your standing rule (D32): after V-14, with a named DB backup and the migration dry run.
   A frame-time-only miss deploys; any other blocker is fixed first. **No rates change in this wave** (that is The
   Climb's).

**To know (not to decide):**

- The 20-player scenes are projected at ≈ 10–12 ms on the dev PC with everything on, against ≈ 13.6–17 today.
- An M1 is the tight case (≈ 14–16 ms in the fight with the Apple rule).
- New gear and dyes add memory and download, not frame time.

---

## 13. Risks

| Risk | Default handling |
|---|---|
| Wave 12's G5 fix slips or changes files this wave touches | step 0 waits for its final commit; the pre-start runs on new files meanwhile |
| The foundation gate stays red at X1 (the projections reuse a busy-machine factor) | foundation fixers first; nothing that costs frame time merges; after 2 days the cut list and the numbers go to the user |
| The machine never goes quiet (parallel agents, the stale process) | N2; the GPU lock and quiet window; interleaved A/B differences are reported as measured, and absolutes wait for a quiet window |
| A T2 character looks wrong where Babylon does something the clip clock does not | CP-A's replay test over every clip; anything uncovered promotes to T1 (CHAR_PERF R1) |
| An M1 misses G1 in the 20-player fight | D16; N1; one more constant (T1 2 everywhere on Apple/iGPU) |
| The High fight stays over 16 ms with cloth | D15 step 2 by default; G2 does not block |
| Cloth's swap at promotion spikes a frame | ≤ 2 promotions a frame (each ≤ 2 ms), the cached container, LAB-14's walk-through |
| Legs through long robes after the edge collision | CL-S's swept-calf test, the re-rendered GIF, H-14 lens 5, per-tune tethers |
| Set-atlas packing confuses Meshy's UV keeping | the pilot set first (D31); fallback one job per piece within the cap |
| Re-bound NPC outfits tear (a child's, a stout mesh) | the 2× stretch test and the S2 fallback (WARDROBE D33) |
| Outfit-cache and dyed-clone memory grows in a busy town | 60 s release of unused outfits; clones keyed by (material, dye key); LAB-14 row 5 |
| The crowd pipeline hits a hard limit (8 buffers, 16 varyings, 16 attributes) | interleaving and one flat varying (D17); CP-R's limit tests fail the build first |
| The townsfolk material at 15 / 16 varyings gets one more | the dye uses the instance colour, no varying; the material-budgets row |
| The Climb later changes W15 stat budgets or sources | stats are content rows copied from CLIMB; wave 15 owns re-tuning (§10) |
| Wave 13 later lands its own authored merge | it reuses D12's file (FISHING FS-I's format) |
| Download grows ≈ 90–125 MB on the server | lazy per family, per gender, per worn set; Brotli; the mini PC's disk is ample |

## 14. Open questions (each has a default, so nobody waits)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | Should T1 be larger on strong High/Ultra machines? | no (CHAR_PERF D2's counts); an Advanced "Detailed characters nearby" row later | the performance pass |
| Q2 | Should an NPC you talk to become T1? | yes (it is your target) | — |
| Q3 | A cheaper mesh for T2 beyond 60 m? | not now | a 40-player event's numbers |
| Q4 | Blobs instead of cascade-0 casters for T2 on integrated GPUs? | yes if N1 shows > 0.3 ms there | N1 |
| Q5 | Party members always T1, past the cap? | no (the cap is the frame budget) | the user after play |
| Q6 | Should hair swing too? | not this wave; the hook is ready (≈ 0.5 day) | wave 16 |
| Q7 | Swing amount: livelier or stiffer? | the prototype tunes + one CL-L pass with before/after clips | the user's look |
| Q8 | Retail cloth parameters (elasticity, fallingSpeed, movementFactor)? | kept in the extras, unused | — |
| Q9 | Can players buy townsfolk outfits as costumes? | no | the user |
| Q10 | Dye prices after The Climb's ×1 rates | keep 600; wave 15's balance lane re-checks | wave 15 |
| Q11 | Dye the retail sets too? | only if cut 3 is not needed | I-14 |
| Q12 | Fur and skin never dyed? | yes | the user after the look |
| Q13 | W15-B interim drop rates | Tiger Girl 20 %, Tiger Mountains 0.3 % | wave 15 replaces them |
| Q14 | A "favourite colours" palette in the Dye window | not this wave | later |
| Q15 | Move the townsfolk onto `SroCrowdSkin` (one VAT runtime for all)? | not this wave (D20); the shared `crowd/` folder makes it a later, small step | the performance pass |

---

## 15. The renumbering (the user's request)

The user, 2026-10-03: "Lets make wave 15 actually wave 14, and current wave 14 make it wave 15". **Wardrobe is wave 14
(this plan); The Climb is wave 15.** This design run writes only this file. The lead lands one **docs-only renumber
commit** before step 0 (D34):

| Where | Today | After |
|---|---|---|
| docs/WAVE_PLAN10.md (≈ 140 mentions of wave 14 / `W14-`) | "wave 14, The Climb"; lanes `W14-*`, `LAB-14`, `S-14`, `BAL-14`, `I-14`, `H-14`, `F-14`, `G-14`, `V-14`; migrations 14–16; D50 "a new OK" | "wave 15"; lanes `W15-PR/CL/SV/SP/CV/WR/G`, `LAB-15`, `S-15`, `BAL-15`, `I-15`, `H-15`, `F-15`, `G-15`, `V-15`; **migrations 12–14**; D50 → the standing deploy rule (rates ×1 still at its deploy); §10's slot table: the W15 rows say "built in wave 14, sources wired in wave 15"; W15-CV extends D12's authored merge |
| docs/CLIMB.md, TOMB_DUNGEON.md, NEMESIS.md, STORM_QILIN.md (5–9 mentions each) | "wave 14" | "wave 15"; TOMB's "LAB-14" → "LAB-15"; CLIMB §4.3's "15 Wardrobe" → "14 Wardrobe" (the ids W15-A…D unchanged) |
| PROJECT_STATUS.md | the order line already reads 14 Wardrobe → 15 The Climb (10-03); older rows say "wave 14 The Climb" and "15 Wardrobe" | the remaining rows follow |
| Dropbox `wave14/w14-preview.png` (The Climb's preview, 2026-10-02) | in `wave14/` | moved to `wave15/w15-preview.png`; `wave14/` holds this wave's `wardrobe-preview.png` and later `budgets.md` |
| `work/tmp/w14-plan/`, `work/tmp/w14-preview.png` (The Climb's scratch) | names say w14 | left as they are (scratch; WAVE_PLAN10's §15 cites them by path) |

**What does not change:** the slot ids **W15-A…D** (and the new W15-E), the W17 slot ids, every content code, and
The Climb's design.

---

## 16. Hooks and deferred

**Hooks left for later waves** (each a seam, no migration needed):

- **Wave 15 (The Climb):**
  - the W15 sources (§10);
  - `char_grants` for its Incense grant (one table instead of a mail module);
  - the dye table's tint rows for elite camps and nemeses;
  - bosses, uniques and the Qilin are T1 always;
  - its loot providers go ahead of `wardrobeDrops`.
- **Wave 16 (Faces & Hair):** hair chains through the cloth system (tassel on `Bip01 Head`, T0/T1 only); T2 hair
  hangs in its retail pose; the crowd array gains the new hair layers.
- **Wave 17 (Arsenal):** weapons as crowd parts on socket slots; weapon glows and trails read the socket bones' CPU
  copy; a family VAT over 4,096 rows splits its skills.
- **The final performance pass:**
  - the per-gear-combo merge for T1 (the set atlases are its input, WARDROBE Q6);
  - the townsfolk on `SroCrowdSkin` (Q15);
  - per-machine defaults (T1 counts, cloth, `'nearest'`);
  - the friends' benchmark (BACKLOG item 9);
  - the HUD's cost.

**Deferred:** the remaster's character normal/ORM maps in an array (BACKLOG B4); impostors; GPU compute skinning;
cloth in a worker; a dye "favourites" palette.

## 17. Housekeeping

- The three specs stay the detailed design; this plan's decisions override them where they differ (D14 cloth = T0 +
  T1 and no warm actors, D15 step 2 by default, D16 the Apple rule, D17 the per-vertex slot, D18 T2 sets, D21 the
  townsfolk back chain, D27 migration 11, D32 the standing deploy rule). I-14 marks the overridden passages.
- No lane commits; the lead integrates each step. No lane starts or stops the user's dev servers (:5180, :7000,
  :5173); private servers on free ports with temp DB copies only; at most one browser tab per lane, closed when done;
  every in-browser timing under the GPU lock on a quiet machine (3 runs, median p95).
- Every Meshy job is a NIGHT_LOG row (D31). **This plan** spent 0 credits, downloaded nothing, opened no browser, took
  no GPU lock and started no server. It took no frame timing: every frame number is a spec's measurement or a
  projection from one, and the X1 gate and LAB-14 measure them.
- Scratch used by this plan:
  - `work/tmp/w14w-plan/budget.py` → `budget.json` (§6.2, §7.2; `python work/tmp/w14w-plan/budget.py`);
  - `work/tmp/w14w-plan/make_preview.py` → `work/tmp/w14w-preview.png` (≈ 2400 × 3381, from the specs' shots and
    `budget.json`), copied to Dropbox as `wave14/wardrobe-preview.png`.
