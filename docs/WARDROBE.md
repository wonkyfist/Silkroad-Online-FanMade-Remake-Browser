# The Wardrobe (wave 14): civilian clothes for the townsfolk, new armour sets, cloth chains, dyes

The user's words, verbatim:

> All npc's walking around town should not have all same gears players have. Thats weird and boring.

> Is it possible to add physics to the clothings? Especially garmet since is supposed to be a garmet.

> create more clothing's

> Clothing dyes, so the new gear and civilian clothes can be recoloured.

> Lets make wave 15 actually wave 14, and current wave 14 make it wave 15

**Wave numbers after the user's renumber (2026-10-03, NIGHT_LOG 06:54):** **wave 14 is the Wardrobe and builds now; wave
15 is The Climb** (docs/CLIMB.md, docs/WAVE_PLAN10.md, designed) and builds after it. Weapons come later in Arsenal
(wave 17). CLIMB.md still says "The Climb (wave 14)" and names its gear slots **W15-A…D** "for the Wardrobe wave".
**The slot ids keep their names** [decision D1: they are ids that CLIMB.md, WAVE_PLAN10 §10 and TOMB_DUNGEON.md already
use; renaming them would churn three documents and change nothing for players]. Where this spec says "W15-B", it means
CLIMB §4.3's slot, built by this wave.

This spec is one of three wave-14 specs; WAVE_PLAN11 merges them:

- **docs/CHAR_PERF.md** (the foundation, being written in parallel): makes the 20-player scenes pass G1 on WebGPU
  Medium **before** this wave adds cloth or new art. This spec only promises not to make its job harder (§8) and offers
  it one lever: every new set is **one material** (§4.6).
- **docs/CLOTH.md** (being written in parallel): the cloth-physics system (the solver, its budget, its LOD). This spec
  says **which garments get chains, on which joints, how long** (§4.7, §3.8), and authors the weights.
- **docs/WARDROBE.md** (this file) owns: **the civilian wardrobe of the townsfolk** (a), **the new armour and clothing
  sets** that fill CLIMB's slots W15-A…D plus a day-one costume set W15-E (b), **the dye system** (masks, dye items, the
  shader, the UI, the wire) (c), **the costume slots**, and the build route of all that art, decided by a bake-off.

**The user delegated every decision.** Wherever there is a choice, this spec takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§10). Only what truly needs the user is in §11 and
§12, each with the default used meanwhile.

**Tags:**

- **[confirmed]**: checked in the working tree's code or data on 2026-10-03, or seen in this spec's prototype
  (`work/tmp/wardrobe/`); each says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement or from data under stated assumptions; not measured in the game.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes. The user may overrule it.

**Design only.** No file under `packages/`, `apps/`, `content/` or `deploy/` was changed; no commit. **Meshy: 40
credits** of the 60-credit design cap (3 jobs, each a NIGHT_LOG row at 07:03–07:08; balance 1,730 → 1,690). No
download. A private Vite on **:5297** served a scratch lab page (the viewer root, `work/out-opt` for the world); one
Browser-pane tab rendered it on WebGPU and WebGL2 and was closed; the Vite was stopped. No game server was started and
no database touched. **No frame timing was taken** (nothing here is a G1 number; the GPU lock was not needed), so every
cost below is [projected]. The dev servers (:5180, :7000, :5173) were not touched.

**Fact-check (2026-10-03, adversarial pass).** Every [confirmed] claim was re-derived from the code (`models.ts`,
`crowd.ts`, `variants.ts`, `vat.ts`, `db.ts`, `content.ts`, `protocol.ts`, the surface plugin), the data
(`equipment.json` + 108 armour sidecars, 43 NPC sidecars, `npcs.json`, `town/index.json`, `shops.json`, `jangan.json`),
Babylon 9.28's shader sources, the prototype's glbs, shots and JSON, the Meshy ledger, NIGHT_LOG, `wave11/budgets.md`
and the sibling CLOTH.md; `material-budgets.test.ts` was re-run (34 green; the crowd material reads 9 units, 15 of 16
inter-stage variables). No code was edited, no Meshy credit spent, no browser or server opened. What changed:

| # | Claim as written | Finding | Fixed in |
|---|---|---|---|
| F1 | One material per set lets "the rescue's `buildMerge`" fold a full new set into one draw "without any new code"; "3 main draws instead of ≈ 9"; "the new art lowers the 20-player draw count" | **False today.** `buildMerge` walks `this.meshes` (the body glb's own parts) and never `this.worn` (its own doc comment: "not what is worn"; CLOTH.md §1.1 agrees). Each item glb is its own `AssetContainer` (own material, `instantiateModelsToScene(…, cloneMaterials = false)`) and its meshes hang under their own `__root__`, while the merge key includes material id **and parent id**. So a set of six pieces is six draws whatever its atlas. The lever exists only if CHAR_PERF adds a worn-item merge **and** a shared material per set atlas, and CHAR_PERF.md (read after it landed) defers that merge out of this wave | §0, §1.4, §4.6, §8.2, D16, Q6, §13 |
| F2 | Chains: robe front/sides on "3 × 3 appended joints (`skirtF1–3` …)" appended to the actor skeleton, weights hand-authored in Blender; the VAT "gains 9–13 joints" | **Collides with CLOTH.md** (written in parallel): chains are made by CLOTH's **auto-rig** from a `content/cloth/rigs.json` row per garment, live in a second glb `<item>.cloth.glb` with its own joints `cloth_k_j` (never appended to the shared skeleton), worn only by the ≤ 5 / 10 / 20 simulated actors; capes use `cloak01–04` (CLOTH §3 `cape`). Appending to the shared skeleton would also push the men's VAT over TL-V's 2.5 MB cap (2,226,048 B + 1,581 × 13 × 32 B = 2.88 MB) | §0, §4.5, §4.7, §5, D17, Q6, §13 |
| F3 | Townsfolk cloth on `cloak01–04` baked into the VAT, "0 bytes more" | True for a 4-joint back chain (the 43 / 45 joints already in each VAT row, `index.json`: 1,581 / 1,381 frames). But CLOTH's lane **CL-V** plans a generic 8 × 3 ring (+24 joints): 2.23 + 1.21 = **3.44 MB**, over the 2.5 MB VAT cap, and CLOTH cuts it first. One plan is needed | §3.8, D10 |
| F4 | Babylon 9.28 PBR "has no `CUSTOM_FRAGMENT_UPDATE_ALBEDO`", so the dye goes in at `UPDATE_ALPHA` | **False.** The point exists inside the include `pbrBlockAlbedoOpacity` (GLSL line 56, WGSL line 57, right after `surfaceAlbedo *= vColor.rgb`), and our surface plugin already uses it (`surface-plugin.ts` ~l. 410: its wet darkening and rain contrast, priority 250). At `UPDATE_ALPHA` the dye runs **after** that and would erase wetness on dyed cloth | §7.3 |
| F5 | "the smith's near-black skirt dyed indigo keeps its pleats" | **Not what the shot shows.** The skirt is the separate `_al_2s` material, which the lab's regex `^cv_chinashop_smith$` skipped: only the wrist and ankle wraps turned indigo, the skirt stayed retail black-green (`shots/w1_civil_WebGPU.png`, zoomed). Same for the hanfu's `_2s` skirt panel: identical pink in all six crowd colourways. Folds surviving a dye is shown on the hanfu's robe and the tiger chest only | §7.1, §9.2 |
| F6 | Masks "half the albedo's size" | Untested: `mask.py` writes the mask at the albedo's full size, and the shade (A) at half size would blur painted detail on every dyed texel | §7.2 (shade from the albedo itself) |
| F7 | 35 humanoid NPCs share the 36 core joint names; 790–1,630 triangles in 2–5 meshes on one or two 512 × 256 textures | 41 of 43 carry the 36 names; **Storage-keeper Sansan uses `Bip02 *` names** (0 matches: W9 needs a `Bip02 → Bip01` alias); the gacha machine has 2 bones. 786–1,627 triangles in 1–7 meshes; most have one 512 × 256 (or 256 × 512) plus a small `_al` texture, a few 3–4 | §1.3, §3.3, §3.4 |
| F8 | The head cut drops every triangle weighted ≥ 0.5 to `Bip01 Head` | That also drops hats: M11's turban ("kept: it is a hat") would be cut | §3.3 |
| F9 | Walking guards today "double as player pets" (players can hire them) | Not in this game: `cos.json` has no guard entry. D9 stands on the look | §3.7, D9 |
| F10 | The 20-player cost read for Medium only | `wave11/budgets.md`: **WebGPU High is far from 60 fps with 20 players already** (plaza 19.4 ms, Tiger Girl 25.5 ms), WebGL2 High plaza 8.2 ms against G2's ≤ 8. The task asks Medium **and** High | §1.4, §8 |
| F11 | New items, shop tabs and drop rows go in `content/items/wardrobe.json` etc. | The authored-item merge (`packages/convert/src/data/authored.ts`) is **wave 13's** (FISHING FS-I), and wave 13 now builds after 17 (PROJECT_STATUS, NIGHT_LOG 06:54). Unique drops resolve only codes in `items.json` (`uniques.ts` `data.items.has`). Without the merge none of the 113 new items exists in game. Also no lane made their **icons** | §7.6, §13 (WR-SEAM, WR-D) |
| F12 | W15-B ships "= 03_A per piece + the family bonus" | The set bonuses are The Climb's (CLIMB §4.2, lane S-SETS, wave 15): wave 14 ships the per-piece stats only | §4.8 |
| F13 | Low needs CPU-baked dye copies because "whether the Low material path accepts plugins is unknown" | On Classic, characters keep the glTF loader's `PBRMaterial`s; `decorateCharacterMaterial` only skips the surface plugin [likely: read in `surface-plugin.ts`]. So the same plugin can run on Low for dyed pieces only; the CPU copies (and a CPU decode of KTX2 textures) are not needed | §7.3, D21, Q5 |
| F14 | UI files `apps/game/src/ui/windows/dye.ts` | HUD windows live in `apps/game/src/hud/*` (`shop.ts`, `inventory.ts`); the kit is `ui/kit/**` | §7.7, §13 |
| F15 | The appearance message "+ ≤ 40 bytes per dyed player" | The wire is JSON (`connection.ts` `JSON.stringify`): a fully dyed player (8 slots) is ≈ 180 bytes | §8.2 |
| F16 | Prototype "no shader error in either run" | True (`err: null`), but every material in both JSON files reads `ready: false`, and the lab never ran the game's decorators (no surface or fog plugin, no shadows on the actors): the shots prove the plugin draws, not that it fits the real character material | §9.2 |
| F17 | W15-E costumes are re-proportioned S1/S2 bases | A Scholar's robe costume on M7's base puts a player in a townsperson's clothes: the user's rule in reverse | §3.1, D3 |
| F18 | (seam, new) CHAR_PERF.md landed during this pass | Its far tier T2 carries **one** dye triplet per character in an instance buffer shared by all parts (its §2.3, §12), but dyes are per piece; and its CP-0 moves the shared crowd code to `world-render/src/crowd/`, which `town/crowd.ts` edits must follow | §7.3 (D34), §13 seams, §15 |

Confirmed as written: 18 people variants dressed in `CLOTHES_01/02/03` and `LIGHT_01` grade A (Mrs Jang's own
`shops.json` rows); `crowd.ts` 825–827 write rgb 1; `pbrBlockAlbedoOpacity` line 48; `UPDATE_ALPHA` at
`pbr.fragment.js` 177 / WGSL 162; 456 manifest items, 26 bodies, 108 armour glbs, all with `colorTint`, none weighted
to `cloak01–04`, `Bone01` only on the women's `clothes_0x_ba` and `light_03_ba`; skeletons 43 / 45 joints; 43 NPC
models with the named NPCs of §3.4 (Grocery Trader Jinjin = `chinashop_accessoryshopgirl`); variant triangles 1,499–2,084
and 1024 × 512 atlases; prototype 1,024 / 1,195 triangles (`stats.mts` re-run); JG_002 "Pests in the Millet", level 1;
Tiger Girl in `content/uniques.json`; the Meshy ledger (RT1 10, T1a 20, T1b 10; balance 1,730 → 1,690; RT1 1 min 23 s)
and NIGHT_LOG 07:03–07:08; 10 DB migrations, `items` and `storage_items` the only equipment tables; `EQUIP_SLOTS`
never indexed by position; `composeWorn`, `warmup-hooks.ts`; the counts (88 pieces, 22 sets, 24 dyes, 32 agent-days
before this pass, ≤ 450 credits) add up.

---

## 0. Summary

1. **Today the townsfolk wear player gear** [confirmed: `packages/convert/src/town/variants.ts` `TOWN_PEOPLE`]: all 18
   people variants are a player body dressed in `ITEM_CH_{M,W}_CLOTHES_01/02/03` or `LIGHT_01` grade-A sets, the very
   pieces a level-1 to 21 player buys from Mrs Jang. The per-instance tint TOWN_LIFE §3.2 planned was never built:
   `town/crowd.ts` writes every instance colour as (1, 1, 1, alpha) [confirmed: lines 825–827]. So 60 people are 10
   meshes in 10 fixed colourings of player armour (`shots/w1_crowd_WebGPU.png` shows two of them next to the new folk).
2. **Civilian clothes come from the 43 retail NPC models, re-bound to the townsfolk skeleton** (§3) [confirmed by the
   prototype]: their Biped joints carry the same names as `europeman_skel` / `europewoman_skel` (41 of 43; Storage-keeper
   Sansan's `Bip02` skeleton through an alias, fact-check F7), so a pure-maths re-bind
   (each vertex moved from the NPC's bind pose to the body's by its own skin weights) puts the blacksmith's clothes or the
   grocery girl's hanfu on a walking townsperson, with a player face and hair instead of the NPC's head. Plus new Blender
   pieces (hats, aprons, sashes, carry-bags, a farmer's tunic) and Meshy retextures of NPC clothing for new patterns.
   **Townsfolk never wear a player item glb** (a content check, §3.1). **≈ 30 outfits** (16 male, 14 female) from which
   the converter bakes the preset's 10 / 14 / 18 variants as today (one draw each, one VAT per gender), each variant with
   **8 colourways** chosen per instance: Medium shows up to 80 distinct looks to 60 people (§3.5).
3. **New player sets** (§4): **W15-A Terracotta Regalia** (T6–T7, 18–20: heavy, light and garment, × 2 sexes = 6 sets,
   36 pieces), **W15-B Tiger-Hunter's** (T5, 16: 6 sets, 36 pieces), **W15-C Ferryman's coat and hat** and **W15-D Millet
   Farmer's clothes** (cosmetic, 2 sexes each), and **W15-E, three Tailor's costumes per sex** sold for gold on day one so
   new clothing exists before The Climb wires its sources. **88 pieces** in all. Cosmetics go into two new visual-only
   slots, **`costume`** and **`costumeHat`** (§4.3), like retail's later avatar slots.
4. **Build route, decided by a bake-off** (§6; 40 credits): **B, Meshy retexture on the retail (or kitbashed) UVs**, won
   for new looks: one 10-credit job turned the retail `LIGHT_02` chest into a tiger-hunter's lamellar with a fur collar
   that reads as a new set piece in the game camera, skinned and animated with no fitting work (`shots/w1_armourClose_*`).
   **C, Meshy text-to-3d** (30 credits) gave a faceted tiger-skull mask that covers the face and would need hand fitting:
   rigid props only. **A, Blender kitbash on the retail meshes and skeleton**, is the geometry route (NPC re-binds, new
   silhouettes, cloth panels). The recommendation is **A for shape + B for paint**, with each set's pieces packed into one
   UV atlas so **one retexture job paints a whole set** in one consistent style (≈ 22 jobs + re-rolls, ≤ 450 credits).
5. **One material per set** (§4.6): the six pieces of a new set share one 1024² atlas. **Today that saves no draw**: the
   G1 rescue's part merge only merges the body glb's own parts, never worn items, and each item glb brings its own
   material and root node [confirmed: `models.ts` `buildMerge` reads `this.meshes`; fact-check F1]. The atlas is the
   input of a later merge only: CHAR_PERF.md (now written) keeps the rescue's merge for its near tier T1 and puts the
   one-draw-per-character merge **out of this wave** (its §4.1); its far tier T2 draws one batch per distinct part for
   all characters (§4.2 there). So the new sets keep today's draw count (6 pieces = 6 draws, or 6 batches in T2), and
   **costumes lower it** (one glb replaces six pieces, §4.3).
6. **Cloth chains where they fit** (§4.7, §3.8): every garment-class robe, the Ferryman's straw cape, the Tiger-Hunter's
   pelt tail and the Regalia's sash ends get chains **through CLOTH.md's auto-rig** (one `content/cloth/rigs.json` row
   per garment; CLOTH makes the `<item>.cloth.glb` with its own chain joints). The skeleton's unused 4-joint chain
   **`cloak01–04`, in both player skeletons, worn by no Chinese item** [confirmed: every Chinese piece's sidecar] is
   CLOTH's `cape` kind for the straw cape. For the townsfolk a back chain on `cloak01–04` is **simulated offline and
   baked into the VAT**, at 0 bytes (the joints are already in every VAT row) and 0 ms at run time [projected].
7. **Dyes** (§7): every new piece and every civilian outfit has a **dye mask** (R primary, G secondary, B trim; the
   shade that keeps the painted folds is taken from the albedo itself, D31);
   a **dye item** recolours one channel of one piece; the shader is **one extra texture read at the albedo's own UV
   (`vMainUV1`), no new varying**, prototyped as `SroDyePlugin` in GLSL and WGSL and drawing on both backends
   [confirmed: the lab; the build moves it to `CUSTOM_FRAGMENT_UPDATE_ALBEDO`, before the surface plugin's wet
   darkening, fact-check F4]. The crowd picks a palette row through the **instance colour it already has**, so six
   colourways of one template are still one draw (`shots/w1_crowd_*`). **24 dyes** in four tiers plus Bleach: 8 sold by
   Mrs Jang, 8 field drops, 6 from uniques and elites, 2 legendary (§7.4). Dyes stay on the item when traded.
8. **Wire and data** (§7.6): one additive migration (`items.dye`, `storage_items.dye`, a one-time-grant table),
   `ItemStack.dye`, `EntityState.dyes`, the `appearance` message carries dyes, two new EquipSlots, one client message
   `itemDye`. The 113 new items (88 pieces, 24 dyes, Bleach) need the **authored-item merge** that wave 13 was to build;
   wave 13 now comes after wave 17, so this wave's step 0 builds it (fact-check F11).
9. **The prototype** (§9; `work/tmp/wardrobe/wardrobe-preview.jpg`): two civilian outfits (the blacksmith's work
   clothes on `europeman_skel`, the grocery trader's hanfu on `europewoman_skel`), each in retail colours and dyed; the
   W15-B chest from the Meshy retexture with two dye swaps; six thin-instanced townsfolk in six colourways; all on the
   real plaza through `loadWorld` at Medium in the game camera, WebGPU and WebGL2.

### 0.1 Where each request lands

| Request | Where |
|---|---|
| "npc's walking around town should not have all same gears players have" | §3: NPC-outfit re-binds, new civilian pieces, the no-player-gear check, 8 colourways per variant |
| "Thats weird and boring" | §3.5–§3.6: mix-and-match parts, colour rows, the assignment rules; guards in garrison uniforms (§3.7) |
| "add physics to the clothings ... Especially garmet" | §4.7 (players: every garment-class set gets chains), §3.8 (townsfolk: baked into the VAT); the solver is CLOTH.md's |
| "create more clothing's" | §4: W15-A…D (CLIMB's slots) + W15-E Tailor's costumes; 88 pieces; weapons stay in Arsenal |
| "Clothing dyes, so the new gear and civilian clothes can be recoloured" | §7: masks, 24 dyes + Bleach, the plugin, the crowd palette, the Dye window |
| "make wave 15 actually wave 14" | header: the Wardrobe is wave 14 and builds first; slot ids kept (D1); §4.8: what is obtainable before The Climb |
| (task) foundation must fix the 20-player cost before cloth | CHAR_PERF.md; §4.6 one material per set; §8 budgets; §13 lane order: WR art lands after CP's gate |

---

## 1. Survey: what exists today

### 1.1 The crowd is dressed in player armour [confirmed]

`TOWN_PEOPLE` (`packages/convert/src/town/variants.ts`, lines 127–149) lists 18 people. Each is a retail player body
(`chinaman_merchant`, `chinawoman_kisaeng`, …) plus `outfit(gender, set)` = `ITEM_CH_{M,W}_{set}_{BA,LA,FA}[,HA][,AA]_A`
with `set` ∈ {`CLOTHES_01`, `CLOTHES_02`, `CLOTHES_03`, `LIGHT_01`}. `work/out/town/index.json` confirms the export:
`m01` = merchant body + `CLOTHES_01_BA/LA/FA_A`, `w07` = warrior body + `LIGHT_01`, and so on; 1,499–2,084 triangles,
one 1024 × 512 atlas each. Those garments are exactly what Mrs Jang sells (CLIMB §4.1: shops sell grade A) and what every
new character starts in (the starter outfits are `CLOTHES_01`, `LIGHT_01` or `HEAVY_01` `_A_DEF`, `starter.ts`).

The per-instance tint (TOWN_LIFE §3.2, "a per-instance vec4 that recolours the garment's dominant hue") was **not
built**: the crowd's instance colour carries only the fade alpha (`crowd.ts` 825–827 set rgb to 1;
`SroTownFadePlugin` reads `vColor.a`). Babylon multiplies the albedo by the instance colour's rgb in
`pbrBlockAlbedoOpacity` [confirmed: Babylon 9.28 `Shaders/ShadersInclude/pbrBlockAlbedoOpacity.js` line 48], so the
channel is free for the dye palette (§7.3).

### 1.2 The retail wardrobe [confirmed: `work/out/equipment/equipment.json`, sidecars]

- 456 items, 26 Chinese bodies (13 per gender). Armour: 3 classes (**garment** = CLOTHES, **protector** = LIGHT,
  **armor** = HEAVY) × 3 degrees × 3 grades × 2 sexes; grades A/B/C share one glb, so **6 piece glbs per class, degree and
  sex = 108 armour glbs**. Pieces: HA head, SA shoulders, BA chest (REPLACE torso), LA legs, AA hands, FA feet.
- Piece sizes: BA/LA 190–492 triangles at 256², HA/SA/AA/FA 12–338 triangles at 128² (a few SA at 64 × 128). Every armour material carries
  the retail BMT **`colorTint`** flag (the retail engine could tint them; vSRO never shipped dyes for these [likely]).
- **No Chinese piece is weighted to `cloak01–04`**, though both skeletons have that 4-joint chain (europeman_skel 43
  joints, europewoman_skel 45 with `Bone01/02`) [confirmed: every `ITEM_CH_*` sidecar's mesh bone lists]. Only the
  women's `CLOTHES_0x_BA` and `LIGHT_03_BA` use `Bone01`.
- The remaster pack (`work/remaster/pack/ch_*/model.glb` + four views) already holds every Chinese piece unskinned in
  bind pose, ready for a Meshy retexture (wave 9B used it for the 12 approved sets).

### 1.3 The NPC models [confirmed: `work/out/npc/npc/*.json`, `work/out/data/npcs.json`]

43 models; every one is placed in Jangan or its fields. 41 of them use a **Biped skeleton whose core 36 joints carry the
player skeleton's names** (`Bip01 Pelvis`, `Spine_Base` … `Bip01 R Toe0`), plus extras on some (`Bone01–10`, `Tail*`,
`Ponytail*`, the stableman's horse `Bip02`). **The exception is Storage-keeper Sansan
(`chinasystem_warehousekeeper_woman`), whose whole skeleton is named `Bip02 *`** (0 name matches; fact-check F7), and
the gacha machine (2 bones). Each is 786–1,627 triangles in 1–7 meshes (`part1`, `part2`, `_2s`, `_al_2s` alpha
cards), mostly on one 512 × 256 (or 256 × 512) texture that holds the head, the hands and the clothes plus a small
`_al` texture; the storage-keepers (box, chain), the shaman (tiger) and the stableman (horse) have 3–4. Civilian looks among them: the
blacksmith (bare chest, work skirt, red sash), the merchants (×5 robes), the herbalist / physician (shared mesh), the
Buddhist priests (Chinese and Indian), the village chief, the clerks (lottery and ticket sellers), the gambling-house man,
the beggar boy, the storage-keepers, the Islam merchant, six gisaeng, the accessory girl, Mrs Jang, and eight garrison
soldiers (east, west, south, palace; STAND clips only).

### 1.4 What the 20-player scenes cost (why this wave must not add draws)

G1 is at the line on WebGPU Medium in the 20-player scenes; the cost is the player characters: ≈ 580 draws, about 14
parts each (main pass plus shadows), skinning and animation; the frame is CPU-bound (GPU 1.3–1.4 ms) [confirmed:
Dropbox `wave11/budgets.md` "Rescue re-bench"; BACKLOG item 9]. **High is further away** [confirmed: same file]:
WebGPU High reads 19.4 ms p95 in the 20-player plaza and 25.5 ms in the 20-player Tiger Girl fight, and WebGL2 High's
plaza 8.2 ms is already over G2's ≤ 8. The rescue's part merge only merges the **body glb's own parts** that share a
material, skeleton, parent and transform (`models.ts` `buildMerge` walks `this.meshes`, never `this.worn`)
[confirmed], so today a kitted character merges only its body parts and every worn piece is its own draw. CHAR_PERF.md
owns the fix (for Medium and High); this wave's art must at worst keep the draw count (§4.6, §8).

---

## 2. Architecture

```
 retail client ──► packages/convert ──────────────────────────────► work/out ──► client
   NPC models        town/variants.ts: + 'npcOutfit' sources (§3.3)    town/variants/*.glb + mask atlases + palette rows
   player gear       equipment: + new set glbs, set atlases (§4.6)     equipment/* (+ dye masks, + `dye` in the manifest)
   Blender pieces    tools/blender/wardrobe/*.py (kitbash, chains)
   Meshy outputs     texpipe: set atlas split, mask proposer (§7.2)    KTX2 albedo + KTX2 mask per piece / per variant
                                                                                 │
 apps/server: items.dye, itemDye, dyes in appearance (§7.6) ◄──── wire ────► apps/game: CharacterActor applies dyes
                                                                             world-render: SroDyePlugin (actor + crowd)
```

- **The converter does the heavy work offline**: re-binding, atlasing, VAT baking (incl. baked cloth for the crowd),
  mask encoding. The client adds one material plugin and per-part uniforms.
- **The server owns dye state** (it is part of the item, traded with it) and broadcasts it with the appearance.
- **Content owns the catalogue**: `content/wardrobe/*.json` (civilian outfits, colourways, dyes, set rows, masks'
  cluster assignments), so adding an outfit or a dye is data.

---

## 3. Civilian clothes for the townsfolk (a)

### 3.1 The rule: townsfolk never wear player gear [decision D2]

A new content check (`town-wardrobe-check`) fails the convert if any `TOWN_PEOPLE` variant lists an `ITEM_*` code or a
glb that the equipment manifest maps to a player item, or reuses a player item's texture. Reason: the user's rule, made
mechanical so a later edit cannot quietly undo it. The converse also holds for two cosmetic sets: the **Ferryman's straw
cape and wide hat (W15-C)** and the **Millet Farmer's sheaf-embroidered smock and straw hat (W15-D)** have one element
the crowd never gets (the cape, the embroidery), so a player in them is recognisable [decision D3]. The same holds for
**W15-E**, whose costumes start from S1/S2 bases (fact-check F17): the check also fails when a player costume's glb or
texture equals a crowd outfit's, and each W15-E costume carries a silhouette element no crowd outfit has (a longer
train, layered sleeves, a stole) [decision, part of D3: the user's rule works both ways, or players look like
townsfolk].

### 3.2 Three sources [decision D4]

| Source | What | Route | Share of the catalogue |
|---|---|---|---|
| **S1. NPC outfits, re-bound** | the clothes of the retail NPCs (§1.3) moved onto the townsfolk skeleton, the NPC's head cut, a player face and hair kept | maths in the converter (§3.3), proven by the prototype | ≈ 20 of 30 outfits |
| **S2. New Blender pieces** | hats (conical straw *douli*, scholar's *futou* cap, merchant's round cap, headscarf, hairpins), aprons (cook, vendor), sashes, carry-bags, a farmer's hemp tunic and trousers, a porter's vest | bmesh in headless Blender 5.2 on the europeman/woman skeleton (rigid hats on `Bip01 Head`; skinned cloth by weight transfer from the body) | ≈ 10 outfits + the hats and aprons layered on S1 |
| **S3. Meshy retexture of S1/S2** | new patterns on the same UVs (a merchant robe in brocade, a monk robe in patched hemp) | route B (§6), the NPC's or the piece's own UVs | ≤ 10 jobs, ≤ 100 credits |

### 3.3 The re-bind [confirmed: `work/tmp/wardrobe/retarget.mts`, the two prototype outfits]

For every vertex of an NPC skinned mesh with joints `j_k` and weights `w_k`:

```
p' = Σ_k w_k · (B_body[j_k] · IBM_npc[j_k]) · p        n' = normalize(the same blend's 3 × 3 · n)
```

`B_body` is the body skin's bind matrix (the inverse of its IBM) for the joint of the same name; `IBM_npc` the NPC's
inverse bind matrix. The vertex is moved from the NPC's bind pose to the body's by its own weights, so the clothes take
the townsperson's proportions at every joint while keeping their own thickness. Joints the body lacks (`Bone01`,
`Tail*`, `Ponytail*`) follow the **spatially nearest matched joint** (the root never wins) [decision: the first try, the
nearest ancestor, sent the blacksmith's `Bone01/02` to `Bip01` on the floor]. Names are matched after a **`Bip02 ` →
`Bip01 ` alias** (Storage-keeper Sansan's whole skeleton is `Bip02 *`, fact-check F7; the stableman's horse `Bip02`
is a prop and is dropped first). Joint indices are re-written onto the body
skin's order, so the result passes TL-V's existing check that every part's inverse binds equal the body's
(`variants.ts` header) and bakes into the shared per-gender VAT unchanged.

- **The head cut**: triangles whose three vertices have ≥ 0.5 weight on `Bip01 Head` / `Ponytail*` are dropped (152 of
  the blacksmith's, 250 of the grocery girl's); the body's own `*_face` and `*_hair` meshes stay. Any of the 13 faces per
  gender can top any outfit. **Hats are weighted to the head too** (fact-check F8): an outfit row may list a `keepHead`
  UV rectangle or mesh (M11's turban), and then the body's hair is swapped for the short hair of the same gender so it
  does not poke through.
- **Proportions**: the re-bind is a blend of rigid per-joint moves, so an NPC built very differently from the body
  opens gaps at the joints. The two adults of the prototype show none; the **beggar boy (M10) is a child** and is the
  likeliest to tear [likely]. WR-CV's converter test measures the largest edge stretch per outfit (fail above 2×);
  an outfit that fails falls back to an S2 base (M10 → the M13 farmer's tunic, retextured).
- **Props** (hammers, trees, chairs, umbrellas, keys, the shaman's tiger) are dropped by name.
- **Skin tone** [confirmed: the prototype]: the NPC's bare arms and chest are painted in its own skin tone, which does not
  match a player face (the blacksmith's tan torso under the merchant's paler face, `shots/w1_civil_WebGPU.png`). Fix
  [decision D5]: the mask proposer (§7.2) also finds the outfit's skin cluster, and the converter colour-transfers it to
  the chosen face's mean skin colour (Lab mean and spread) when it builds the variant atlas.
- **Body shape**: an NPC outfit keeps its NPC's build (the blacksmith is stout). That is variety, not a bug; the face
  scale is the body's, and the neck seam is hidden by the cut line at the collar [likely; one seam pass per outfit in the
  art lane's review sheet].
- **Cost**: 666 / 696 outfit triangles; with face and hair 1,024 / 1,195 [confirmed: `work/tmp/wardrobe/stats.mts`],
  against TL-V's 3,000-triangle cap and today's 1,500–2,100.

### 3.4 The catalogue [decision D6; the content lane may swap entries]

Roles follow TOWN_LIFE §3.3. "S1:" names the NPC whose clothes are re-bound. Every row lists its parts so S2 pieces can be
layered (hat, apron, sash, bag).

| # | Outfit | Sex | Source | Parts and layers | Roles |
|---|---|---|---|---|---|
| M1 | Smith's work clothes | m | S1: Blacksmith Chulsan | bare chest, work skirt, sash; + leather apron (S2) | worker, porter |
| M2 | Merchant's robe | m | S1: General Sonhyeon's robe (`chinaquest_merchant`) | robe, belt; + round cap | walker, vendor |
| M3 | Travelling trader | m | S1: Specialty Trader Jodaesan | robe, pack; + carry-bag | walker, porter |
| M4 | Physician's gown | m | S1: Herbalist Yangyun (shared mesh with the Merchant Associate) | gown, medicine pouch | walker, chatter |
| M5 | Monk's robe | m | S1: Buddhist Priest Jeonghye | robe, prayer beads | walker, sitter (temple steps) |
| M6 | Pilgrim monk | m | S1: Buddhist Priest Kushyan | robe, shawl | walker |
| M7 | Scholar's gown | m | S1: Lottery Seller Wangwon | long gown; + futou cap (S2) | chatter, sitter (tea house) |
| M8 | Elder's robe | m | S1: Village Chief Hwangno (chair dropped) | robe, sash | sitter, chatter |
| M9 | Gambler's coat | m | S1: Casino Guardian Huhoan | coat, sash | walker (evening) |
| M10 | Labourer | m | S1: Beggar Sochil (a child's mesh: the proportion test of §3.3 decides; fallback M13's base), S3 retexture "patched hemp" | short tunic, rolled trousers; + douli hat | porter, sweeper |
| M11 | Foreign trader | m | S1: Islam Merchant Ishyak | coat, turban (kept by a `keepHead` entry, §3.3; short hair under it) | walker (market) |
| M12 | Storekeeper | m | S1: Storage-keeper Wangu (keys, box dropped) | jacket, apron | vendor |
| M13 | Farmer | m | S2: hemp tunic + trousers + douli | — | walker, porter (south gate) |
| M14 | Cook | m | S2 apron over M2's lower half + headscarf | — | vendor (food stalls) |
| M15 | Ferry hand | m | S1: Ferry Ticket Seller Doji's trousers + S2 vest (no straw cape: W15-C keeps it) | — | porter |
| M16 | Lantern keeper | m | M7 gown + S2 hat + lantern socket (TOWN_LIFE §3.3) | — | lantern carrier |
| W1 | Shop girl's hanfu | w | S1: Grocery Trader Jinjin | hanfu, skirt, sash | walker, vendor |
| W2 | Ticket girl | w | S1: Ticket Seller Gyoun | jacket, skirt | walker, chatter |
| W3–W8 | Six gisaeng dresses | w | S1: Gisaeng So-Ok, Juju, Ahjin, Mihyang, Juyeong, Yumi (umbrellas and loose hair cards dropped) | dress, skirt (alpha cards kept) | walker, chatter, sitter |
| W9 | Housekeeper | w | S1: Storage-keeper Sansan (`Bip02` alias, §3.3; key ring, chain and box dropped) | robe, apron | vendor |
| W10 | Farm wife | w | S2: hemp jacket, wrap skirt, headscarf | — | walker, porter |
| W11 | Tea-house hostess | w | W1 + S2 apron + hairpins, S3 retexture "brocade" | — | sitter (serving), vendor |
| W12 | Weaver | w | S2: plain robe + sleeve ties + basket (carry-bag) | — | walker |
| W13 | Noble lady | w | S1: Adventurer Flora's dress, S3 retexture to a Tang silk pattern | — | walker (palace avenue) |
| W14 | Pilgrim nun | w | M6's robe re-bound to `europewoman_skel` + headscarf | — | walker |

Excluded on purpose: **Mrs Jang's dress** (she is the dye and tailor vendor, §7.4: her clone walking past her stall would
read as a copy), the **Exorcist's** tiger, the stableman (his horse is in his skeleton), the gacha machine and WalYoung's
quest costume. Count: 16 male + 14 female outfits.

### 3.5 Mix and match, without draws [decision D7]

- **A variant stays one dressed body = one draw** (TOWN_LIFE §3.2): a body (one of 13 faces and hairs per gender) + one
  outfit + optional layers (hat, apron, bag), merged and atlased by TL-V's dresser. The converter picks the
  combinations from `content/wardrobe/town.json` (a seeded draw over outfits × faces × layers, then a rank per preset).
- **Per preset as today**: Medium 10 (5 + 5), High 14, Ultra 18, plus guards and elders; Medium keeps its 10 draws.
- **8 colourways per variant**: each variant ships with 8 palette rows (primary, secondary, trim; §7.3); an agent's row
  is a hash of its id, like its variant and gait. **10 variants × 8 rows = 80 looks on Medium** for at most 60 people
  [projected]; High 112, Ultra 144.
- **Row 0 is never the source NPC's own colours** for an S1 outfit (D2's spirit: the Blacksmith himself stands at the
  smithy in his colours; his walking cousins never match him).
- The per-gender VAT is untouched (same skeleton, same clips); only the variant meshes and atlases change.

### 3.6 Never copy-pasted [decision D8]

- **No two agents within 12 m share variant and row** at the same moment: the schedule's agent → (variant, row) table is
  built once per crowd with a greedy recolour over each agent's itinerary neighbours (the itineraries are the pure
  function of TOWN_LIFE §3.4, so every client computes the same table).
- **Gait styles** (TOWN_LIFE §3.2) and the ±5 % height scale stay per agent.
- **Roles constrain outfits**: a cook is not a porter; a monk walks to the temple; vendors wear aprons (the role column
  of §3.4 is the filter).

### 3.7 Guards in garrison uniforms [decision D9]

The eight `chinaetc_soldier*` uniforms re-bound to `europeman_skel` (§3.3, heads kept: helmeted guards should look
alike) give **walking guards in the four garrison colours** (east, west, south, palace), replacing the hireable
mercenary models on patrol (`ch_guard_spear` / `_bow`, retail COS mercenaries; in this game no player can hire them,
`cos.json` has no guard entry, fact-check F9, so the reason is the look: Jangan's own garrison, matching the soldiers
at the gates). Guards patrol near their garrison's gate. Two variants on Medium as today. They move from the
`ch_guard` VAT to the men's VAT (the garrison NPCs have STAND clips only; the re-bind gives them the player WALK).

### 3.8 Cloth on the townsfolk: baked, not simulated [decision D10]

Robe tails, sashes and aprons of the townsfolk are weighted to **`cloak01–04`** (and on the women's skeleton also
`Bone01/02`, which the women's dresses already use). Their motion is **simulated offline** by CLOTH.md's solver (or, if
it has no offline mode, by a damped spring chain in the VAT baker driven by the root and pelvis motion of each clip) and
**baked into the VAT** as ordinary joint frames: the VAT already stores every joint per frame (44 / 46 × 16 half floats),
so the crowd's cloth costs **0 ms at run time and 0 bytes more** [confirmed for the bytes: `vat.ts` bakes every joint
of the skin, `town/index.json` lists 43 / 45 bones, `cloak01–04` and `Bone01/02` among them]. It loops with each clip
and does not react to wind or collisions; at the crowd's distance that is the right trade.

**Seam with CLOTH.md** (fact-check F3): CLOTH's lane CL-V plans a generic 8 × 3 ring baked into each VAT (+24 joints):
for the men 2,226,048 B + 1,581 × 24 × 32 B ≈ 3.44 MB, over TL-V's `VAT_MAX_BYTES` 2.5 MB, and CLOTH cuts CL-V first.
**Decision (D10): the crowd's baked swing is this back chain on the joints the VAT already has**, built by CL-V's baker
code (CLOTH's pure `cloth-sim.ts` step run offline over each loop, seam blended), so it costs no VAT bytes and needs no
skeleton change; a full ring waits for a VAT budget raise that WAVE_PLAN11 would have to grant. The women's
`Bone01/02` are already animated by the retail clips; the bake writes them only where an outfit lists them.

### 3.9 Budgets per variant [decision]

| Item | Limit | Prototype |
|---|---|---|
| Triangles | ≤ 2,500 (TL-V's cap 3,000) | 1,024 / 1,195 |
| Atlas | ≤ 1024 × 512 albedo, as today | NPC textures 512 × 256 + face 512 × 256 + hair 256 × 128 fit |
| Dye mask atlas | same layout, half size (512 × 256), RGB weights (shade from the albedo, D31), KTX2 | full size in the prototype (512 × 256 per NPC texture) |
| Palette | 8 rows × 3 texels per variant, one 3 × (8 × variants) RGBA8 texture for the whole crowd; the instance colour carries the **global** row (variant × 8 + colourway, ≤ 255 rows, so up to 31 variants) | 6 rows, 72 bytes |
| Draws | unchanged (one per variant in view) | thin instances, 1 per mesh |

---

## 4. New armour and clothing sets (b)

### 4.1 The slots (CLIMB §4.3, WAVE_PLAN10 §10) and what this wave adds

| Slot | Name in play | What | Tier / level | Source (CLIMB) | Stat budget (CLIMB) |
|---|---|---|---|---|---|
| **W15-A** | **Terracotta Regalia** (WAVE_PLAN10 D27) | heavy, light, garment sets, 6 pieces | T6–T7 / 18–20 | the Qin-Shi Tomb only (Regalia tokens + the Steward's exchange) | = Seal of Star B per piece + the SoS set bonus |
| **W15-B** | **Tiger-Hunter's** | the three classes | T5 / 16 | Tiger Mountains drops, MB5, Tiger Girl | = 03_A per piece + the family bonus |
| **W15-C** | **Ferryman's coat and hat** | civilian clothes | any | the ferry quest JG_X07, then the far bank's vendor | cosmetic |
| **W15-D** | **Millet Farmer's clothes** | civilian clothes | any | a B1 quest reward | cosmetic |
| **W15-E** (new) | **Tailor's costumes** | civilian clothes, 3 per sex | any | Mrs Jang's Tailor tab, gold | cosmetic |

W15-E is this wave's addition [decision D11]: with The Climb now built after the Wardrobe, W15-A, C and the MB5 source of
B have no source on the day the Wardrobe ships (§4.8). "create more clothing's" should be visible at once, and a gold
sink helps The Climb's ×1 economy later.

### 4.2 How many [decision D12]

| Slot | Classes | Sexes | Pieces per set | Sets | Pieces |
|---|---|---|---|---|---|
| W15-A | heavy, light, garment | 2 | 6 (HA, SA, BA, LA, AA, FA) | 6 | 36 |
| W15-B | heavy, light, garment | 2 | 6 | 6 | 36 |
| W15-C | costume | 2 | 2 (coat = costume, hat = costumeHat) | 2 | 4 |
| W15-D | costume | 2 | 2 | 2 | 4 |
| W15-E | costume | 2 | 1 + an optional hat on one of them | 6 | 8 |
| **Total** | | | | **22** | **88** |

Reason: one set per class and sex is what an SRO set means (players of every build can wear "the" Tiger-Hunter's);
fewer would leave a class out of the tier, more is a later wave's content.

### 4.3 Costume slots [decision D13]

- Two new EquipSlots, **`costume`** (one full-body piece: torso, arms, legs, feet in one glb) and **`costumeHat`**.
  Visual only: **no stats, no durability**, never in the stat sum. Retail SRO added the same idea later as avatar slots.
- **Drawing rule** (an addition to `@sro/appearance` `composeWorn`): when `costume` is worn, the six armour slots are not
  drawn (weapon and shield are); `costumeHat` replaces the head piece's visual. Wearing is showing: to show the armour,
  unequip the costume (no toggle state) [decision: one less piece of state and UI].
- Costumes take dyes (§7) like armour.
- **Draws**: a costume wearer draws the body, hair, the costume (+ its hat) and the weapon instead of six armour pieces:
  **−4 to −5 main draws (and as many shadow draws) per costume wearer today**, with no merge code [projected: from
  `composeWorn`'s rule; the hidden armour is not instantiated]. The costume must be **one material** and list the
  REPLACE slots chest, legs, hands and feet so the body's base meshes hide as they do for armour.

### 4.4 Look direction [decision D14]

Shared rules: **SRO's Chinese style, painterly** (hand-painted value shapes, soft lighting painted in, no photographic
noise), **retail silhouettes extended, not replaced** (a new set must still read as SRO next to retail gear), **three
dye channels designed in from the start** (a dominant cloth or leather, a secondary, a metal or embroidery trim), and a
**unique silhouette element per set** so it is recognisable at 30 m.

| Set | Silhouette element | Materials and palette (undyed) | Garment / light / heavy |
|---|---|---|---|
| **W15-A Terracotta Regalia** | small-plate lamellar of the Qin terracotta warriors with a short flared skirt of plates; a topknot crown (head) | lacquered black-brown plates, cinnabar cords, malachite-green and azure under-robe, bronze rivets (the warriors' original pigments) | garment: a long robe with a lamellar chest panel and long sash ends; light: plate vest over the robe; heavy: full lamellar with shoulder plates |
| **W15-B Tiger-Hunter's** | tiger-pelt shoulders and a pelt tail at the back; a fur-trimmed hood on light and garment, a tiger-mask visor on heavy | dark leather, orange-black fur (never dyed: the trim channel is the bronze), crimson cords | as RT1 (`shots/w1_armourClose_WebGPU.png`) on the 02/03 meshes |
| **W15-C Ferryman's** | the straw rain cape (*suoyi*) and the wide conical hat | straw, indigo hemp, rope | costume |
| **W15-D Millet Farmer's** | a smock embroidered with millet sheaves, a straw hat with a chin cord | undyed hemp, ochre embroidery | costume |
| **W15-E Tailor's** | m: Scholar's silk robe, Merchant's brocade coat, Lantern-night robe; w: Silk hanfu, Brocade jacket and skirt, Lantern Festival dress | silk and brocade in dye-friendly light values | costume |

The art lane produces a turnaround sheet per set (four views, game lighting, undyed + two dyes) for the user's look gate
(G5, §11).

### 4.5 Build route per set (from the bake-off, §6) [decision D15]

| Set | Geometry (route A, Blender kitbash) | Paint | Rigging |
|---|---|---|---|
| W15-A | retail 03 pieces of each class as the base; new bmesh plate skirt, plate panels, crown, sash ends | **route B**: one retexture per set on the set atlas | retail weights; a `rigs.json` row per hanging part (§4.7) |
| W15-B | retail 02/03 pieces; new fur mantle cards on SA, pelt tail on BA | **route B** (RT1 proved it) | retail weights; tail: a `rigs.json` `tail` row |
| W15-C | the ferry NPC's trousers re-bound (§3.3) + a new straw-cape mesh (layered cards) + hat (rigid) | route B | cape: CLOTH's `cape` kind on `cloak01–04` (+ a 3 × 4 fan when wider) |
| W15-D | S2 farmer tunic (§3.4 M13/W10 share its base, the smock and hat are unique) | route B | hem: a `rigs.json` ring row (tier B) |
| W15-E | S1/S2 bases re-proportioned, new sleeves and skirts, each with its own silhouette element (§3.1) | route B | robe tails: `rigs.json` rows |

- **Never route C for skinned clothing** (§6: it does not fit a body and has no skin). Route C (text- or image-to-3d)
  only for **rigid props**: a hat or crown blank that Blender then cleans to ≤ 400 triangles; budget at most 3 jobs.
- Route B jobs run per **set atlas** (§4.6): the set's 6 pieces are UV-packed into one 0–1 space before upload, so one
  10-credit job paints all six in one style; the result is cut back into the 1024² set atlas. 22 sets + 50 % re-rolls ≈
  **33 jobs ≈ 330 credits**, + S3 civilian retextures ≤ 100: **≤ 450 credits** [projected; RT1 cost 10]. Build cap 600,
  keeping ≥ 1,000 of the 1,690 balance [decision].

### 4.6 One material per set (one paint job per set now; a merge input later) [decision D16]

- Every new set's six pieces share **one 1024² albedo atlas + one 512² dye mask** (per class and sex).
- **What it does today: nothing for draws** [confirmed, fact-check F1]. `buildMerge` merges only the body glb's own
  parts (`this.meshes`); worn items (`this.worn`) are never merged. Each item glb is its own `AssetContainer` with its
  own `PBRMaterial` (`instantiateModelsToScene(…, cloneMaterials = false)` shares it between wearers of the same item,
  not between items), and each item's meshes hang under its own `__root__`, while the merge key includes the material
  id and the parent id. A new set therefore draws as 6 pieces, exactly like a retail set.
- **What CHAR_PERF.md does with it** (owner of `buildMerge` and any worn-item merge, CLOTH §11 agrees; CHAR_PERF was
  written in parallel and read in this fact-check): T1 keeps the rescue's merge and freezes materials; the
  one-draw-per-character merge (a texture array keyed by the worn set) is **not this wave** (CHAR_PERF §4.1, §4.2
  "per-gear-combo merge, later"); T2 draws one crowd batch per distinct part, so a new set is 6 batches shared by
  every T2 wearer. A later merge would need (1) a worn-item merge keyed on world-equal transforms rather than the root
  node, (2) one material instance per set atlas shared across the set's glbs, (3) equal vertex layouts, which the
  converter guarantees for a set's pieces (a WR-CV test). Then a full new set would draw body + hair + set + weapon ≈
  **4 main draws instead of ≈ 9** [projected].
- Dyed pieces keep such a merge only when their dyes match: a dyed material is a clone keyed by (set atlas, dye key),
  so pieces with equal dyes share it (§7.3). A player who dyes every piece differently gets one draw per piece, as today.
- A garment simulated by CLOTH wears its `<item>.cloth.glb` with its own skeleton and never merges (CLOTH §1.1); that is
  at most the 5 / 10 / 20 simulated actors of CLOTH §6.5.
- If CHAR_PERF composes a per-character atlas instead, the set atlas is simply one of its inputs (and the dye is baked
  there, D20). If it does neither, the new sets cost what retail sets cost: **never more draws** [projected].

### 4.7 Cloth chains for players [decision D17; the solver, its LOD and its budget are CLOTH.md's]

This spec only says **which** garments swing and **what kind** of chain each gets; CLOTH.md's auto-rig makes the
chains (fact-check F2). Each row below is a `content/cloth/rigs.json` row the art lane owns (CLOTH §11), checked by
CLOTH's `pnpm sro cloth` (§4.3 there) in the art lane's own test.

| Piece | CLOTH kind (CLOTH §3) | Joints | Why |
|---|---|---|---|
| Every garment-class robe (W15-A garment, W15-E, W15-C coat) | `ring` 12 × 4 (man) / 10 × 4 (woman), one **chain set** per set and sex owned by the BA or LA piece (CLOTH §4.5) | CLOTH's `cloth_k_j` in the `<item>.cloth.glb` | "Especially garmet": the whole hem swings, front and sides too |
| W15-D smock hem | `ring` 8 × 2 (tier B) | as above | a short hem |
| W15-A sash ends | `sash` 1 × 4 each | as above | silhouette element |
| W15-B pelt tail | `tail` 1 × 4 | as above | silhouette element |
| W15-C straw cape | `cape` on `cloak01–04` (+ a 3 × 4 fan on `Bip01 Spine1` if wider) | the skeleton's own `cloak01–04` | the showcase cloth piece |
| Heavy armour plates | none (tier C) | — | plates do not flow |
| Retail garments | CLOTH's own choice (its §2.3: the retail cloth panels of `clothes_01` / `03`) | — | not this spec's |

- No joint is appended to `europeman_skel` / `europewoman_skel`: the chains live in the cloth glb, so every existing
  glb, inverse bind and the crowd's VAT stay as they are (an append would have pushed the men's VAT to 2.88 MB, over
  TL-V's 2.5 MB cap).
- Without the solver (Low, players beyond CLOTH's 5 / 10 / 20 simulated actors) the actor wears the plain glb: the robe
  hangs on its retail-style weights, as robes do today (CLOTH §6.5).
- The art lane authors only the garment's mesh and its retail-style body weights; a hand fix-up of a chain set uses
  CLOTH's optional Blender pass.

### 4.8 Stats, sources, and what is obtainable before The Climb [decision D18]

- **Item rows** go into `content/items/wardrobe.json` (codes `ITEM_CH_{M,W}_W15A_{HEAVY,LIGHT,CLOTHES}_{HA..FA}`, …),
  stats copied from CLIMB's budgets (W15-A = the Seal of Star B row of the same piece and class; W15-B = the 03_A row),
  required level per CLIMB (A 18 + by piece ≤ 20; B 16). **The family bonus** of W15-B is The Climb's set-bonus system
  (CLIMB §4.2, lane S-SETS): in wave 14 the pieces carry their per-piece stats only and the tooltip's set line shows
  "(set bonus with The Climb)" [fact-check F12].
- The rows exist in game only through the **authored-item merge** (`packages/convert/src/data/authored.ts`, FISHING
  FS-I's design), which WR-SEAM builds in step 0 because wave 13 now lands after wave 17 [fact-check F11]; unique drops
  already skip codes missing from `items.json` (`uniques.ts`). Every new item also needs an **inventory icon** (113:
  88 pieces, 24 dyes, Bleach), rendered in headless Blender from the item glb like FISHING's `icons.py` (WR-D).
- **Before The Climb** (wave 15) builds:

| Slot | Obtainable in wave 14 | Wave 15 then |
|---|---|---|
| W15-A | **no** (the Tomb does not exist). Rows ship `enabled: false`; the Tailor's **try-on mirror** (§7.7) lets players preview it | TB-L's Regalia tokens + the Steward's exchange |
| W15-B | **yes**: Tiger Girl (live since wave 11) drops one piece at 20 %, the Tiger Mountains' current monsters 0.3 % per kill | CLIMB's `drops.json` (B5 drops, MB5) replaces the interim rows |
| W15-C | no (JG_X07 is The Climb's); preview only | JG_X07, the far-bank vendor |
| W15-D | **yes**: added to **JG_002 "Pests in the Millet"** (level 1, the millet fields) [confirmed: `content/quests/jangan.json`]; characters who already finished JG_002 get it once at their next login (recorded in the migration's `char_grants` table, so it never repeats) | CL-Q keeps it or moves it |
| W15-E | **yes**: Mrs Jang's new Tailor tab, 40,000–120,000 gold | unchanged |

---

## 5. Cloth in one place

| Who | Chains | How it moves | Cost |
|---|---|---|---|
| Townsfolk | robe tails, sashes, aprons on `cloak01–04` (+ `Bone01/02` on women) | simulated offline with CLOTH's step, baked into the VAT (§3.8) | 0 at run time, 0 VAT bytes |
| Players, new garment-class robes, costumes, sashes, the tail | CLOTH's auto-rig chains from this wave's `rigs.json` rows; the straw cape on `cloak01–04` (§4.7) | CLOTH.md's solver, its LOD and budget (≤ 5 / 10 / 20 simulated actors) | CLOTH.md's (Medium ≈ +0.22–0.35 ms CPU p95) |
| Players, retail robes | CLOTH's own choice (its §2.3) | CLOTH's | CLOTH's |
| Heavy plates | none | as today | 0 |

---

## 6. The build-route bake-off [confirmed: `work/tmp/wardrobe/meshy/`, ledger + NIGHT_LOG rows 07:03–07:08]

**Method.** Three routes, one target (the W15-B chest, plus a tiger-head piece for route C), judged in the game
camera on the real plaza (§9), within the 60-credit cap. Runner `work/tmp/wardrobe/meshy/wardrobe_meshy.mts` (the
repo's `MeshyClient`; key read by the client, never printed; ledger with resume and a cap check before every create).

| Route | Job | Credits | Time | Result | Verdict |
|---|---|---|---|---|---|
| **A** Blender kitbash on retail meshes and skeleton | the two civilian outfits (NPC re-binds, §3.3) and the composed armour characters (`compose.mts`) | 0 | minutes | fits and animates by construction; shape work is manual in Blender for new silhouettes | **the geometry route** |
| **B** Meshy retexture, original UVs | **RT1**: retail `ITEM_CH_M_LIGHT_02_BA` (pack model.glb) + a tiger-hunter prompt, `ai_model latest`, 2K | **10** | 1 min 23 s | dark lamellar, orange-black fur on the collar and shoulder tops (in game mostly under the retail `SA` pads: the set's own SA piece must carry the fur), a painted tiger-face boss, bronze studs, red cords; UVs and skin untouched; worn and animated at once (`shots/w1_armourClose_*`). The tiger face is more photographic than SRO's paint (prompt tuning), seams show stretched stripes where the retail UV islands are thin | **the paint route** |
| **C** Meshy text-to-3d (+ refine) | **T1a** preview (meshy-7.1, 3k triangles) + **T1b** refine (2K) of "a tiger-pelt hood worn as a helmet" | **20 + 10** | 3 min | a faceted tiger-skull mask, 3,083 triangles, one material, no skin; on the head it covers the face and needs hand placement and cleanup | **rigid props only** |

Total **40 credits** (balance 1,730 → 1,690); 20 credits of the cap unspent [decision: the verdict was clear].

---

## 7. Dyes (c)

### 7.1 The model [decision D19]

- A dyeable piece has **three channels**: **primary** (the dominant cloth or leather), **secondary** (lining, skirt,
  cords), **trim** (metal, embroidery). Fur, skin, hair and painted faces are never dyed.
- An item stores **three dye ids** (0 = undyed, 1–255 = a row of the dye table), packed `p | s << 8 | t << 16` in one
  integer. One **dye item colours one channel of one piece**; **Bleach** resets all three channels of a piece.
- Dyeable: every new set piece (W15-A…E), every civilian outfit (the crowd's colourways are dye rows), and — a stretch
  goal, first in the cut list — the 108 retail armour glbs (their masks come from the same proposer, reviewed in a
  batch).
- **Recolour, not tint**: a dyed texel becomes `dye × shade`, where shade is the painted luminance over the channel's
  mean, so the painted folds, seams and highlights survive any dye (the hanfu's robe dyed jade and the tiger chest dyed
  navy keep their folds; `shots/w1_civil_WebGPU.png`, `w1_armourClose_WebGPU.png`). The smith's skirt was **not** dyed
  in the prototype: it is the separate `_al_2s` material the lab skipped (fact-check F5); in the build every part of a
  variant or set is one material, so the mask covers skirts and alpha cards too.

### 7.2 Masks [confirmed for the method: `work/tmp/wardrobe/mask.py`, three masks]

- **Format**: RGBA, the piece's own UVs. **R, G, B** = primary, secondary, trim weights (soft: a 3 × 3 box filter of
  the hard labels, so the dye edge follows the painted edge); **A = shade** = linear luminance ÷ the channel's mean
  luminance ÷ 2 (0.5 = the channel's average). Texels in no channel: RGB 0, A 0.5. KTX2 (BC7 / ASTC / ETC2 by device,
  texpipe's encoder) [decision: the albedo's own path, nothing new].
- **Size** (fact-check F6): the prototype's masks were **full size**; "half the albedo's size" was never tried, and a
  half-size A would blur the painted detail of every dyed texel. **Decision:** the shader takes the shade from the
  albedo it has just read (`dot(albedo, luma) ÷ the channel's mean`, the three means per material as one uniform vec4,
  per variant for the crowd), so A is no longer needed for shading and the RGB weights, which are smooth, ship at
  **half size** (512² for a set atlas, 512 × 256 per crowd variant). The result is the prototype's maths at the
  albedo's full resolution [projected; WR-R's parity test compares it with the full-size A path on the three
  prototype textures].
- **The proposer** (texpipe tool `wardrobe-masks`, from `mask.py`): k-means (k = 7–8) in Lab with lightness half-weighted
  (a fold is the same cloth), writes a review sheet (the texture, the clusters, a legend) and takes an assignment line
  per texture from `content/wardrobe/masks.json` (`"light_02_ba_w15b": "p:4,6 s:0 t:5"`), so a mask is reproducible
  data, not a hand-painted file. A hand-painted override PNG is allowed where clustering fails.
- **Prototype results**: blacksmith p = work skirt (13.5 % of texels), s = sash (1.7 %); grocery girl p = robe (36.1 %),
  s = skirt (17.9 %), t = red borders (4.9 %); RT1 p = leather (64.7 %), s = cords (4.6 %), t = bronze (1.9 %), fur left
  undyed. Gaps seen: some fur-stripe texels fell into the leather cluster (they turn the dye colour); the review sheet
  catches that, and the fix is a cluster split or an override [confirmed: `masks/rt1_clusters.png`].

### 7.3 The shader [confirmed: `work/tmp/wardrobe/lab/wardrobe-lab.ts` `SroDyePlugin`, GLSL and WGSL]

A Babylon `MaterialPluginBase` on the actor's PBR material. **The prototype** injected at `CUSTOM_FRAGMENT_UPDATE_ALPHA`
(priority 250) on the belief that Babylon 9.28 PBR has no albedo point. **That was wrong** (fact-check F4):
`CUSTOM_FRAGMENT_UPDATE_ALBEDO` exists inside the include `pbrBlockAlbedoOpacity` (GLSL line 56, WGSL line 57), right
after `surfaceAlbedo *= vColor.rgb`, and our surface plugin already injects there (priority 250: its wet darkening,
the rain contrast and `sroLuma`). Plugins inject in ascending priority, so **the build injects at
`CUSTOM_FRAGMENT_UPDATE_ALBEDO` with priority 240**: the dye runs first and the wet and rain edits darken the dyed
cloth like any other [likely: the point and the ordering are read in code; WR-R's parity test compiles it in both
languages with the surface plugin on]. At `UPDATE_ALPHA` the dye would run after the wetness and erase it on dyed
texels. The prototype's code, as tested:

```glsl
#ifdef SRO_DYE
{
  vec4 sroDm = texture2D(sroDyeMask, vMainUV1);          // the ONE extra read, at the albedo's own UV
  vec3 sroB = surfaceAlbedo;
#if defined(SRO_DYE_INST) && defined(INSTANCESCOLOR) && defined(INSTANCES)
  sroB = sroB / max(vColor.rgb, vec3(1.0 / 256.0));       // undo Babylon's albedo × vColor.rgb
  int sroRow = int(vColor.g * 256.0 - 0.5);               // the crowd: palette row from the instance colour
  vec4 sroP = texelFetch(sroDyePal, ivec2(0, sroRow), 0);
  vec4 sroS = texelFetch(sroDyePal, ivec2(1, sroRow), 0);
  vec4 sroT = texelFetch(sroDyePal, ivec2(2, sroRow), 0);
#else
  vec4 sroP = sroDyeP; vec4 sroS = sroDyeS; vec4 sroT = sroDyeT;   // a player's part: three UBO vec4s
#endif
  float sroSh = sroDm.a * 2.0;
  sroB = mix(sroB, sroP.rgb * sroSh, sroDm.r * sroP.a);
  sroB = mix(sroB, sroS.rgb * sroSh, sroDm.g * sroS.a);
  sroB = mix(sroB, sroT.rgb * sroSh, sroDm.b * sroT.a);
  surfaceAlbedo = sroB;
}
#endif
```

- **No new varying** in either path: `vMainUV1` is the material's main UV, `vColor` the crowd's existing instance colour
  (its alpha stays the fade). The crowd encodes the global row as `(1, (row + 1) / 256, 1, alpha)`. This matters: the
  crowd material already uses **15 of 16 inter-stage variables** and 9 texture units [confirmed: `material-budgets.test.ts`
  re-run, "town crowd variant"]; the dye adds 2 units (mask, palette) and no varying. The `SRO_DYE_INST` branch also
  requires `!defined(VERTEXCOLOR)` (the crowd's stand-in mesh is vertex-coloured, and `vColor` would then be the
  product of both colours).
- **Cost** [projected]: one filtered fetch + ~12 ALU per character fragment (the crowd adds three `texelFetch`). Characters
  cover a few percent of the screen; at 20 players well under 0.05 ms of GPU on the dev PC (Ryzen 5 9600X + RX 9060 XT),
  whose 20-player frame is CPU-bound at 1.3–1.4 ms of GPU anyway. On a GPU ten times slower (an integrated Intel or an
  M1) it stays below ≈ 0.1–0.3 ms at 1080p [projected: ≈ 100 k character fragments]. Nothing in it is vendor-specific:
  no texture arrays, no integer textures (the RGBA8 palette is read as floats), no derivatives, no extension; the same
  maths on WebGPU and WebGL2. **No CPU cost per frame** beyond the UBO's three vec4s per dyed material. WR-LAB measures
  it (the plaza with 20 dyed players).
- **Variants and warm-up**: `SRO_DYE` (+ `SRO_DYE_INST` for the crowd) double **every actor define set that can wear a
  dyed piece** (skinning influences, alpha test, two-sided, self-lit…), not "one pipeline per family". The warm-up
  (world-render `warmup-hooks.ts`) enumerates them the way it enumerates today's actor sets, so the first dyed stranger
  never hitches (G4); WR-R's test counts them.
- **Undyed pieces** carry no plugin define (identical shader to today), so undyed players cost nothing.
- **If CHAR_PERF composes a per-character atlas**, the dye is applied **in that compose pass** (the mask atlas and the
  per-piece dye triples are inputs; the composed albedo comes out dyed) and the runtime define is off for those
  characters: zero runtime cost, re-composed on a dye change. The own character and every preview keep the plugin
  (instant feedback in the Dye window) [decision D20].
- **CHAR_PERF's far tier T2** (its §2.3, §12) plans the dye as the instance's tint slot, **3 colours in 16 B, one
  instance buffer shared by all of a character's parts**. That holds one triplet per character, but a dye is per piece
  (up to 8 slots × 3 channels). **Decision D34:** the T2 slot carries a **dye-row index**; a dye table texture holds
  one row per dyed T2 character (8 slots × 3 channels = 24 RGBA8 texels, rewritten only on a dye or tier change), and
  each part batch knows its equipment slot as a batch uniform, so the lookup is the crowd's palette path
  (`texelFetch(sroDyeTable, ivec2(slot * 3 + ch, row))`), still one instance write per character and no extra draw.
  CP-R owns the slot, WR-R the lookup; WAVE_PLAN11 confirms it with CHAR_PERF.
- **Low (Classic)**: dyes still show, because dye is identity [decision D21]. On Classic the character materials are
  still the glTF loader's `PBRMaterial`s; `PbrSurfaces.decorateCharacterMaterial` only skips the surface plugin there
  [likely: read in `surface-plugin.ts`, fact-check F13]. So **the same plugin** runs on Low, attached only to dyed
  pieces' material clones: an undyed Low character is byte-identical to today (the Low guard gains that assertion). The
  earlier plan, CPU-baked albedo copies, is dropped: it needed a CPU decode of KTX2 textures and a 64-copy cache for
  nothing the plugin cannot do.
- **Dye colours** are authored in sRGB and converted to linear before upload (the albedo is linear in the shader).

### 7.4 Dye items [decision D22]

24 dyes in four tiers + Bleach. Item codes `ITEM_ETC_DYE_<NAME>`, stack 50, tradeable (Legendary bound on pick-up).

| Tier | Dyes (sRGB) | Source | Price (shop) |
|---|---|---|---|
| **Common** (8) | Ink Black `#1f1d1c`, Undyed Hemp `#cdbb94`, Indigo `#2f4f8f`, Madder Red `#9e2b25`, Ochre `#c08a2e`, Willow Green `#6f8a3c`, Ash Grey `#8a8780`, Plum `#6a3a6a` | **Mrs Jang, new "Dyes" tab** | 600 gold each |
| **Uncommon** (8) | Jade `#3f8f6f`, Cinnabar `#c8402c`, Saffron `#e0a526`, Peony `#d0607a`, Sky `#6a9ac8`, Walnut `#5a3a22`, Pine `#2f5a3a`, Ivory `#efe6cf` | field drops 0.3 % per kill (the band's two dyes by area), quest rewards in the 6–15 questline | — (sells back for 300) |
| **Rare** (6) | Lacquer `#262c38`, Imperial Yellow `#e8b830`, Kingfisher `#1f7a8c`, Oxblood `#6b2a1a`, Celadon `#9cc3a8`, Royal Purple `#5a2a7a` | uniques: Tiger Girl 2 per kill (one per looter), elite and champion monsters 2 % | — |
| **Legendary** (2) | Storm Indigo `#3a3f9a`, Gilt Bronze `#d4a64a` | rows `enabled: false` until wave 15: the storm Qilin (STORM_QILIN) and the Tomb's last boss | — |
| **Bleach** | resets a piece | Mrs Jang | 200 gold |

- Prices are a gold sink sized against today's ×3 economy [projected: a full common dye of a set = 18 dyes ≈ 10,800
  gold, ≈ a T3 shop piece]; The Climb's ×1 economy may halve them (an open question, §12).
- Townsfolk colourways are drawn from the Common + Uncommon dyes, so a player can match a townsperson's look but the
  rare and legendary colours stay player-only [decision D23].

### 7.5 Rules [decision D24]

- Dyeing needs a dye item in the bag; it is allowed anywhere out of combat (no NPC needed), on worn or bagged pieces.
- A dye on a channel the piece's mask does not have is refused (`dye_no_channel`).
- Dyes are part of the item: kept when traded, stored, sold in a stall (the listing shows the colours), and through +N
  alchemy. Durability loss and repairs do not touch them.
- Bleach costs one Bleach per piece and resets all three channels. No refund of dyes.

### 7.6 Wire and data (additive) [decision D25]

- **Migration** (number fixed by WAVE_PLAN11 at build time; `db.ts` has 10 today, so 11 if nothing lands first):
  `ALTER TABLE items ADD COLUMN dye INTEGER NOT NULL DEFAULT 0`; the same on `storage_items` (the only two tables that
  hold equipment [confirmed]); `CREATE TABLE char_grants (character_id INTEGER NOT NULL REFERENCES characters(id),
  grant_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (character_id, grant_id))` for one-time grants (§4.8's
  JG_002 catch-up). Stall listings (in memory) carry the dye. Old rows read as undyed.
- **Authored items** (fact-check F11): `packages/convert/src/data/authored.ts` merges `content/items/*.json` and
  `content/shops/*.json` into the exported `items.json` / `shops.json` (a retail-code collision, a missing model or icon
  are errors), as FISHING FS-I designed it for wave 13; built here in step 0 because wave 13 now comes after wave 17,
  and kept compatible so wave 13 and The Climb (W14-CV's extension to mobs, skills, cos) reuse it. Field and unique
  drop rows for the interim sources (§4.8) and the dyes (§7.4) go in `content/wardrobe/drops.json`, read by the
  server's loot chain before the retail table, and replaced by CLIMB's `drops.json` in wave 15.
- **`packages/shared`**: `EquipSlot` gains `'costume' | 'costumeHat'` (appended to `EQUIP_SLOTS`, so nothing re-indexes);
  `ItemStack.dye?: number`; `EntityState.dyes?: Partial<Record<EquipSlot, number>>`; the `appearance` message gains
  `dyes?`; new client message `{ t: 'itemDye'; target: { equip: EquipSlot } | { bag: number }; channel: 0 | 1 | 2 | 'bleach'; dye: number /* bag slot of the dye item */ }`;
  error codes `dye_no_channel`, `not_dyeable`, `not_a_dye`. Validated in `validate.ts`; protocol stays v1.
- **Content types**: `DyeDef { id: 1..255, code, name, srgb, tier }` in `content/wardrobe/dyes.json`; the equipment
  manifest's `EquipmentModel` gains `dye?: { mask: string; channels: number /* bitmask */ }`.

### 7.7 UI (UI.md's kit, `apps/game/src/ui/kit/**`) [decision D26]

- **The Dye window** (`apps/game/src/hud/dye.ts`, built from `ui/kit/**`; opened by using a dye item, or from the
  inventory's piece context menu "Dye…"): the preview is **the player's own character in the world** (the camera
  swings to face it while the window is open, drag to rotate), not a second 3D panel [decision, fact-check pass: a
  render target or second scene would cost frame time while open and new UI code; the own actor is already drawn]. The
  six armour slots plus costume and hat down the left, each with three channel swatches; clicking a swatch with a dye
  selected **previews live** (client-only plugin uniforms on the own actor's dyed clones), **Apply** sends `itemDye`
  and consumes one dye, **Reset preview** reverts (also on close). Bleach appears as a "clear" swatch. Undyeable
  channels are greyed.
- **Tooltips**: "Dyed: Lacquer / Azure / Silver" under the item name; the set line as CLIMB's ("Tiger-Hunter's (4/6)").
- **The Tailor tab at Mrs Jang** (`hud/shop.ts`'s tab row): W15-E costumes for sale and a **try-on mirror** that dresses
  the player's own in-world character client-side in any W15 piece or costume (locked ones marked with their source;
  others see nothing, the server is not told) — the preview of The Climb's rewards. Each try-on loads that glb on demand.
- **Character creation** keeps today's starter clothes; dyeing starts in game.
- i18n strings in `apps/game/src/i18n/en-wardrobe.ts`.

---

## 8. Budgets

### 8.1 Per preset

| Preset | Townsfolk | Players |
|---|---|---|
| Low | no crowd (as today) | the same plugin on dyed pieces only (undyed = today, byte for byte); no chains; new sets at a 256² tier of the set atlas |
| **Medium** | 10 variants, 8 colourways each, baked cloth; draws unchanged; + the palette texture and one mask per variant | the plugin on dyed materials; new sets at 1024² set atlases (KTX2), 6 draws per set like retail (§4.6); costumes −4 to −5 draws each; chains per CLOTH.md (5 simulated actors) |
| High / Ultra | 14 / 18 variants (as today) | as Medium; CLOTH's 10 / 20 simulated actors |

### 8.2 Numbers [projected unless tagged]

- **Draws**: crowd unchanged; a costume wearer −4 to −5 main draws (and shadow draws) in T1, and one batch instead of
  six in T2 (§4.3); a full new set the same as a retail set (§4.6, fact-check F1). Nothing in this wave adds a draw.
- **GPU**: the dye read ≤ 0.05 ms at 20 dyed players on the dev PC (AMD), ≈ 0.1–0.3 ms on a GPU ten times slower;
  baked cloth 0. No vendor-specific path (§7.3).
- **CPU**: 0 per frame (UBO values only change on a dye change).
- **Memory**: per new set atlas 1024² KTX2 ≈ 1.4 MB with mips + a 512² mask ≈ 0.35 MB; 22 sets ≈ 39 MB on disk at most,
  loaded only when worn. Crowd: +1 mask atlas per variant (512 × 256 ≈ 0.18 MB) ≈ 2–3 MB on Ultra; the palette 1 KB.
- **Download**: +≈ 45–55 MB of assets (sets, masks, civilian variants); the sets load on demand.
- **Server**: one integer per item row; the wire is JSON, so a fully dyed player's `dyes` adds ≈ 180 bytes to the
  spawn and `appearance` messages (sent on change only) [fact-check F15].
- **High** (fact-check F10): WebGPU High already misses 60 fps with 20 players (plaza 19.4 ms, Tiger Girl 25.5 ms p95;
  `wave11/budgets.md`) and WebGL2 High's plaza is 8.2 ms against G2's ≤ 8. This wave's own share on High is the same
  as on Medium (≈ 0 CPU, ≤ 0.05 ms GPU, no draw); CLOTH adds +0.4–0.62 ms CPU on High (its §7). Getting High to 60 fps
  with 20 players is CHAR_PERF's and the performance pass's (PROJECT_STATUS: "High 60 fps with 20+ players").

### 8.3 Gates this spec asks of WAVE_PLAN11

- **G1** with every dye and a crowd of new variants on: the plaza with 20 dyed players in new sets, WebGPU and WebGL2
  Medium, after CHAR_PERF's foundation lands (WR-LAB; the LAB id is WAVE_PLAN11's, "LAB-14" being TOMB_DUNGEON's).
- **G2 / High**: the same scene on WebGPU and WebGL2 High, Wardrobe on − off ≤ 0.2 ms p95 (High's absolute 60 fps is
  CHAR_PERF's gate, not this wave's).
- **G3**: no existing scene slower than before by > 0.2 ms (Medium and High).
- **Vendors**: the LAB runs on the dev PC (AMD); the friends' NVIDIA and Mac check is the performance pass's
  one-time benchmark (PROJECT_STATUS). Until then NVIDIA and Apple are [unknown] for timings, though the shader uses
  nothing vendor-specific.
- **G4**: 0 compiles on the first dyed character (warm-up), 0 WebGPU validation errors, the Low guard green.
- **G5 (look)**: each set's turnaround and the crowd at noon and dusk pass the user's look; until then the default
  ships (§11).
- **G7 (data)**: `town-wardrobe-check` green; every mask's channels match its manifest bitmask; the migration keeps every
  row.

---

## 9. The prototype

### 9.1 What was built [confirmed: `work/tmp/wardrobe/`]

| File | What |
|---|---|
| `retarget.mts` | the NPC-outfit re-bind of §3.3 (gltf-transform, no Blender): `cv_smith_m.glb` (Blacksmith Chulsan's clothes on `chinaman_merchant`'s skeleton, face and hair), `cv_shopgirl_w.glb` (Grocery Trader Jinjin's hanfu on `chinawoman_merchant`) |
| `compose.mts` | a player body + retail items by the manifest's rules, with a texture override: `tiger_vest_m.glb` (the `LIGHT_02` set with RT1's chest), `retail_light02_m.glb` |
| `mask.py` | the mask proposer (§7.2): `masks/*_clusters.png` review sheets, `masks/*_mask.png` |
| `meshy/wardrobe_meshy.mts` | the bake-off runner and ledger (RT1, T1a, T1b and their files) |
| `lab/vite.config.mjs`, `lab/wardrobe-lab.ts` | the lab: `loadWorld` (jangan-fields, Medium, PBR, modern sky, out-opt) on the plaza, the game camera (ArcRotate, fov 0.85, beta 1.25–1.42, radius 4.2–13), `SroDyePlugin`, thin-instanced crowd test |
| `make_sheet.py` → **`wardrobe-preview.jpg`** | the preview sheet |

### 9.2 What it showed [confirmed: the shots in `work/tmp/wardrobe/shots/`]

1. **The re-bind works**: both NPC outfits play the player WALK / STAND1 clips on the townsfolk skeleton with no
   visible tearing, with a player face (`w1_civil_*`).
2. **The skin-tone seam** on the bare-chested blacksmith (tan body, pale face) is real; D5's colour transfer is needed.
3. **Dyes keep the paint**: the hanfu's robe dyed jade / cream / gold keeps its folds and reads as another outfit, not a
   tinted one. **But only the main material was dyed** (fact-check F5): the smith's skirt (`_al_2s`) stayed retail
   black-green, only his wrist and ankle wraps turned indigo; the hanfu's long `_2s` skirt panel is the same pink in all
   six crowd colourways. The build's one-material variants and sets remove that gap; the prototype did not show it.
4. **Route B makes a new set piece**: the tiger-hunter chest reads as new gear next to the retail `LIGHT_02` set; two dye
   swaps ("lacquer": navy / blue cords / silver; "oxblood": red / gold / gilt) make it three looks
   (`w1_armourClose_*`). The bright result of dyeing near-black leather shows the shade normalisation lifting dark cloth
   to the dye's value: intended, and the dye table's dark entries cover "stay dark".
5. **Route C** (the hood) sits on the head as a mask over the face: rejected for wearables.
6. **The crowd path**: one template, six thin instances, six colourways from the instance colour — one draw per mesh
   (`w1_crowd_*`), next to today's townsfolk in player clothes.
7. **Both backends**: the same shots on WebGL2 match WebGPU (`*_WebGL2.png`); no shader error in either run
   (`w1_WebGPU.json`, `w1_WebGL2.json`: `err: null`, though every material there reads `ready: false` at capture).
   The lab did **not** run the game's character decorators (no surface or fog plugin, no shadows on the actors), so it
   proves the plugin draws, not that it fits the real character material (fact-check F16): the material-budgets guard
   and WR-R's parity test cover that.

Not prototyped (named so nobody assumes it): the VAT bake of the new variants, the baked cloth, CHAR_PERF's compose
path, the plugin on Low, the `UPDATE_ALBEDO` injection with the surface plugin, the shade-from-albedo mask, the
server and UI, the set atlas packing for one retexture per set, CHAR_PERF's worn merge, any frame timing.

---

## 10. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Keep the slot ids W15-A…D although the Wardrobe is now wave 14 | ids, not schedule; renaming churns three docs |
| D2 | Townsfolk never use a player item glb or texture; a content check enforces it | the user's rule, made mechanical |
| D3 | W15-C/D each keep one element the crowd never gets; W15-E never shares a glb or texture with a crowd outfit and carries its own silhouette element (checked both ways) | a player's cosmetic must stay recognisable; the user's rule works in reverse too |
| D4 | Civilian sources: NPC re-binds + new Blender pieces + a few Meshy retextures | the NPC clothes are retail-authentic, free and proven; Blender fills the roles they lack |
| D5 | Colour-transfer an NPC outfit's skin to the chosen face | the prototype's seam |
| D6 | The 30-outfit catalogue of §3.4, Mrs Jang's dress excluded | covers every role in TOWN_LIFE §3.3 and every type the task named |
| D7 | Variants stay one draw; 8 colourways per variant by instance colour | variety without draws |
| D8 | No two agents within 12 m share variant and colourway; roles filter outfits | "copy-pasted" is a local effect |
| D9 | Garrison uniforms re-bound for walking guards (onto the men's VAT) | Jangan's own soldiers instead of retail COS mercenaries; one VAT fewer (not because players hire them: in this game they cannot) |
| D10 | Crowd cloth: a back chain on `cloak01–04` (+ the women's `Bone01/02`) simulated offline with CLOTH's step and baked into the VAT; not CL-V's 8 × 3 ring | 0 run-time cost and 0 VAT bytes; the ring would take the men's VAT to 3.44 MB, over the 2.5 MB cap |
| D11 | Add W15-E Tailor's costumes | new clothing on day one; a gold sink |
| D12 | One set per class and sex for A and B (88 pieces in all) | what a set means in SRO |
| D13 | Visual-only `costume` and `costumeHat` slots; wearing is showing | cosmetics without a stat trade-off; no toggle state |
| D14 | Look rules of §4.4: retail silhouettes extended, three dye channels designed in, one unique element per set | new but still SRO |
| D15 | Route A for geometry, route B for paint, route C only for rigid props | the bake-off |
| D16 | One material (1024² atlas + 512² mask) per new set | one retexture job paints a whole set in one style (the credit plan rests on it); it is the input of CHAR_PERF's later per-gear-combo merge; it saves no draw in this wave (today's merge never touches worn items, and CHAR_PERF defers the T1 merge) |
| D17 | Chains on garment robes, the smock hem, capes, sashes and the pelt tail, as CLOTH `rigs.json` rows (ring, sash, tail, cape); none on plates; nothing appended to the shared skeletons | "especially garment"; one cloth system (CLOTH's auto-rig) instead of two; the VAT and every old glb stay valid |
| D18 | Interim sources: B from Tiger Girl and the Tiger Mountains, D from JG_002, E from the Tailor; A and C wait for wave 15 | each slot's source stays CLIMB's where it exists |
| D19 | Three channels per piece, dye ids packed per item, recolour by shade | painted detail survives; one integer per item |
| D20 | Runtime plugin for previews and unmerged parts; dye in CHAR_PERF's compose pass where it exists | instant preview; zero cost on composed characters |
| D21 | Dyes show on Low through the same plugin, on dyed pieces only | a dye is identity; Classic characters are still PBR materials, so no CPU copy is needed and undyed Low stays byte-identical |
| D22 | 24 dyes in four tiers + Bleach; common ones sold by Mrs Jang | a ladder from gold to bosses |
| D23 | The crowd uses only Common and Uncommon dyes | rare colours stay a player's mark |
| D24 | Dyes travel with the item; Bleach resets; no NPC needed to dye | simple, tradeable value |
| D25 | Additive migration and wire (one column, optional fields, one message) | protocol v1 stays compatible |
| D26 | The Dye window and the Tailor's try-on mirror preview on the player's own in-world character | dyes are chosen by eye; no second scene or render target to pay for |
| D27 | Build Meshy cap 600 credits, plan ≤ 450, keep ≥ 1,000 | RT1 cost 10; one job per set atlas |
| D28 | Retail gear masks are the first scope cut | the user asked for new gear and civilian clothes |
| D29 | WR-SEAM builds the authored-item merge (`data/authored.ts`, items + shops) and a wardrobe drop overlay in step 0 | wave 13, which was to build it, now lands after wave 17; without it no new item exists in game |
| D30 | 113 item icons rendered in headless Blender from the item glbs (WR-D) | every new item needs an inventory icon; no download, one style |
| D31 | The dye shade comes from the albedo at run time; the mask ships RGB weights at half size | full-resolution painted detail on dyed cloth at half the mask memory |
| D32 | The plugin injects at `CUSTOM_FRAGMENT_UPDATE_ALBEDO`, priority 240 | the dye must come before the surface plugin's wet and rain edits |
| D33 | The re-bind aliases `Bip02` to `Bip01`, keeps hats by a `keepHead` entry, and fails outfits whose joints stretch > 2× | Sansan's skeleton, M11's turban and the child's mesh would otherwise break |
| D34 | CHAR_PERF's T2 tint slot carries a dye-row index into a per-character dye table (8 slots × 3 channels), not one triplet | dyes are per piece; one instance write per character and no extra draw stay true |

## 11. Needs from the user

**To start: nothing.** Every tool is installed, no download is needed, and every item has a default.

1. **The preview sheet** `work/tmp/wardrobe/wardrobe-preview.jpg`: the two civilian outfits, the tiger-hunter chest with
   two dyes, the six-colour crowd. **Default:** build as shown.
2. **Meshy credits for the build: ≤ 450** (cap 600) of the 1,690 balance. **Default:** spend up to 450, stop at 600.
3. **The look gate per set** (turnaround sheets during the build). **Default:** the art lane's pick ships if you do not
   answer.
4. **After the build, about 20 minutes**: walk the market and the plaza at noon and dusk ("does the crowd still look
   copy-pasted?"), dye one piece, wear a Tailor's costume, watch a robe swing. **Default:** the numbers stand.
5. **The deploy OK** follows your standing rule ("After every wave, just deploy"), with a named DB backup before the
   migration.

## 12. Open questions (each has a default)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | Should players be able to buy townsfolk outfits (e.g. the gisaeng dresses) as costumes? | no: the crowd's clothes stay the crowd's | the user |
| Q2 | Dye prices after The Climb's ×1 rates | keep 600; WAVE_PLAN for wave 15 re-checks with its gold model | wave 15's balance lane |
| Q3 | Dye the retail sets too? | only if the cut list leaves room (D28) | I-14 |
| Q4 | Fur and skin never dyed? | yes | the user after the look gate |
| Q5 | Does the plugin compile on Classic's character materials? | likely yes (they stay `PBRMaterial`); if not, Low shows undyed (cut 6) | WR-R |
| Q6 | Should CHAR_PERF's later per-gear-combo merge (its §4.2) use the set atlases? | yes, when it is built (the final performance pass); until then new sets draw like retail sets (no regression) | the performance pass |
| Q7 | W15-B's interim drop rates (Tiger Girl 20 %, Tiger Mountains 0.3 %) | as written; wave 15's drops.json replaces them | wave 15 |
| Q8 | Legendary dyes' sources (Qilin, Tomb) | rows disabled until wave 15 | wave 15 |
| Q9 | A dye "favourites" palette in the Dye window | no in this wave | later |

---

## 13. Lanes

Effort in agent-days. Every lane reads its sections here and WAVE_PLAN11's row. **Order:** step 0 seams → step 1 lanes
in parallel → art lanes merge **after CHAR_PERF's G1 gate passes** (§8.3; the new sets' one material is designed to
help CHAR_PERF's worn merge, never to depend on it). The art lanes' chains need CLOTH's CL-R (`rigs.json` format and
`pnpm sro cloth`); the crowd's baked swing needs CLOTH's `cloth-sim.ts` step.

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **WR-SEAM** (step 0) | `packages/shared/src/{content, protocol, validate}.ts` (EquipSlots, `ItemStack.dye`, `EntityState.dyes`, `appearance.dyes`, `itemDye`, error codes, `DyeDef`), `packages/appearance/src/{manifest, compose}.ts` (`dye` on models; the costume drawing rule), `apps/server/src/db.ts` (the migration: `dye` columns, `char_grants`), `packages/convert/src/data/authored.ts` (new: the items + shops merge, FISHING FS-I's design, D29) + one line each in `data/items.ts` / `data/shops.ts`, the server's wardrobe drop overlay hook, `packages/world-render/src/pbr/dye-plugin.ts` (the plugin skeleton at `UPDATE_ALBEDO` priority 240, both languages, registered in the actor decoration and the warm-up) | — | protocol round-trip; `composeWorn` with costume / costumeHat; the migration step test keeps every row; merge round trip (a retail-code collision, a missing model or icon are errors); plugin parity test (same keys GLSL/WGSL, compiled with the surface plugin on), `material-budgets.test.ts` (actor and crowd sets with `SRO_DYE`) | — | 3 |
| **WR-CV** converter | `packages/convert/src/town/{variants, npc-outfit}.ts` (the §3.3 re-bind with the `Bip02` alias, head cut with `keepHead`, skin transfer, layered S2 pieces, palette rows, mask atlas), `packages/convert/src/equipment/sets.ts` (set atlases, equal vertex layouts per set, manifest `dye`), `town-wardrobe-check` (both directions, D3) | WR-SEAM (manifest types) | re-bind of the blacksmith equals the prototype within 0.1 mm; IBM check passes; joint stretch ≤ 2× per outfit; no player glb or texture in any variant and no crowd glb or texture in any costume; every mask matches its bitmask; TL-V budgets incl. VAT ≤ 2.5 MB | the crowd sheet | 3.5 |
| **WR-MASK** masks | `packages/texpipe/src/wardrobe-masks.ts` (half-size RGB weights + the per-channel mean luminances, D31), `content/wardrobe/masks.json`, review sheets under `work/` | WR-CV | deterministic clusters (seed); every listed texture has a mask; channel coverage reported | the mask sheets (optional) | 1.5 |
| **WR-ART-CIV** civilian art | `packages/convert/tools/blender/wardrobe/*.py` (hats, aprons, sashes, bags, farmer clothes, the `cloak01–04` back-chain weights of the crowd outfits), `content/wardrobe/town.json` (the catalogue, colourways), S3 retexture packs | WR-CV, WR-MASK, CLOTH's step for the bake, Meshy ≤ 100 cr | each outfit converts, ≤ 2,500 triangles, both skeletons; turnaround sheet | the crowd at noon and dusk | 4 |
| **WR-ART-A** Terracotta Regalia | Blender kitbash + one retexture per set atlas, 6 sets; their glbs and atlases via WR-CV; their `content/cloth/rigs.json` rows | WR-CV, WR-MASK, CLOTH CL-R, Meshy ≤ 120 cr | each piece binds on its skeleton; one material per set; `pnpm sro cloth` passes on every row | turnaround | 5 |
| **WR-ART-B** Tiger-Hunter's | as A, 6 sets | as A, ≤ 120 cr | as A | turnaround | 4 |
| **WR-ART-CDE** costumes | W15-C, D, E (10 costume pieces + hats) | as A, ≤ 110 cr | as A; the costume rule draws no armour | turnaround | 3.5 |
| **WR-R** render | `packages/world-render/src/pbr/dye-plugin.ts` (full: shade from the albedo, the crowd branch with `!VERTEXCOLOR`), the crowd's `SRO_DYE_INST` path in `town/crowd.ts` (palette texture, global row written in `take()` and kept by `release()`'s colour copy, the fade alpha kept), `apps/game/src/three/models.ts` (per-part dyes, dyed material clones keyed by (texture, dye key), on Low too), the warm-up entries | WR-SEAM | shader parity incl. the full-size-A comparison (D31); wet darkening applies to dyed cloth; a dyed and an undyed part never share a material; 0 allocations per frame; Low guard (undyed Low byte-identical); no compile on the first dyed stranger | dye a piece | 2.5 |
| **WR-SV** server | `apps/server/src/wardrobe.ts` (itemDye, bleach, rules of §7.5), shop rows (Mrs Jang's Dyes and Tailor tabs), interim drops (Tiger Girl, Tiger Mountains), JG_002's reward + the one-time grant, GM `/dye` and `/give` for sets | WR-SEAM | every refusal; trade, storage, stall and alchemy keep dyes; costume never adds stats; the one-time grant once | — | 2 |
| **WR-D** content | `content/items/wardrobe.json` (88 pieces, stats per CLIMB's budgets, `enabled` per §4.8), `content/wardrobe/dyes.json`, `content/shops/wardrobe.json`, `content/wardrobe/drops.json`, the 113 icons (`content/items/icons/**`, rendered by `tools/blender/wardrobe/icons.py`, D30) | WR-SEAM | content check; stats equal the referenced rows; every item has an icon | — | 2 |
| **WR-UI** client | `apps/game/src/hud/dye.ts` (kit-built), the Tailor tab and mirror in `hud/shop.ts`, tooltips in `hud/items.ts`, `apps/game/src/i18n/en-wardrobe.ts` | WR-SEAM, WR-R | UI tests on the mock server; preview never sends and reverts on close; apply consumes one | dye, try on | 2 |
| **WR-LAB** bench | the LAB rows of §8.3, Medium and High, WebGPU and WebGL2 (the GPU lock, quiet machine, 3 runs, median p95) | all | G1/G2/G3/G4 | — | 1.5 |

**Totals** [projected]: seams 3, converter and masks 5, art 16.5, render 2.5, server and content 4, UI 2, bench 1.5:
**≈ 34.5 agent-days** (fact-check: +1.5 authored merge, +1 icons, +0.5 converter checks, +0.5 High bench, −0.5 no Low
copy, −0.5 no preview scene), the art lanes in parallel. **Meshy ≤ 450 credits** (≤ 100 + 120 + 120 + 110).

**Seams no lane may cross after step 0**: WR-SEAM's files; one owner per shared file (`town/crowd.ts`: WR-R, **after**
CHAR_PERF's CP-0 has moved the shared crowd pieces to `packages/world-render/src/crowd/`; the T2 dye lookup in
CP-R's `SroCrowdSkin`: WR-R's code in CP-R's file, by WAVE_PLAN11's order (D34); `models.ts`: WR-R, after CHAR_PERF's
CP-S / CP-A, which freeze T1 materials: a dye unfreezes for one frame; `variants.ts`: WR-CV). Every art lane writes only its own
Blender scripts, packs and content rows; converts go through the convert lock. No lane starts or stops the user's dev
servers; private servers on free ports with temp DB copies; one browser tab per lane, closed when done; every timing
under the GPU lock.

## 14. Scope-cut order (cut from the top) and never-cut

1. Retail gear masks (D28).
2. The try-on mirror (the Tailor tab still sells).
3. W15-E's third costume per sex.
4. S3 civilian retextures (colourways still vary the crowd).
5. The chains of W15-E and W15-D (W15-A's robes, the pelt tail and W15-C's cape keep theirs).
6. Dyes on Low (Low shows undyed; the server still stores dyes).
7. High/Ultra's extra crowd variants (Medium's 10 stay).
8. W15-A's garment class (heavy and light stay).
9. The garrison-uniform guards (the mercenaries stay on patrol).

**Never cut:** townsfolk out of player gear (D2's check), the dye mask + plugin + Dye window, W15-B (obtainable now),
W15-D (JG_002), one material per set, and the G1 gate.

## 15. Risks

| Risk | Default handling |
|---|---|
| CHAR_PERF's foundation slips, so new art lands on a red G1 | art lanes merge after its gate (§13); new sets draw like retail sets, costumes draw less |
| CHAR_PERF defers the worn-item merge (its §4.1, as written) | the set atlas saves no draw this wave (§4.6); nothing regresses; it is the input of the later per-gear-combo merge |
| CHAR_PERF's T2 carries one dye triplet per character, WARDROBE dyes per piece | the T2 slot carries a dye-row index instead (D34, §7.3); WAVE_PLAN11 settles it with CP-R |
| Wave 13 later lands its own `data/authored.ts` | it reuses this one (same format as FISHING FS-I); WAVE_PLAN11 records the owner |
| Re-bound NPC clothes clip at the collar or the wrists on some faces | the head cut line and a per-outfit review sheet; 13 faces tested per outfit by the converter's bounding check |
| Route B paints photographic detail (the tiger face) | prompt rules (painterly, large shapes); a re-roll budget of 50 %; texpipe's painterly pass as fallback |
| Set atlas packing for one retexture per set confuses Meshy's UV-keeping | first job is a pilot set; fallback is one job per piece (≈ 3×) within the 600 cap, else fewer re-rolls |
| Masks miss texels (fur in the leather cluster) | the review sheet, cluster splits, override PNGs |
| Instance-colour decoding conflicts with a later use of `vColor.rgb` | the row lives in green only; the fade keeps alpha; a test asserts the encoding |
| A garment's chains (CLOTH's cloth glb) and the set material disagree | the cloth glb is cut from the same set glb with the same atlas; CLOTH's checks run in the art lane |
| Re-bound outfits tear at the joints (a child's or a very stout mesh) | the 2× stretch test; S2 fallback (D33) |
| The Climb later changes W15 stat budgets | stats are content rows copied from CLIMB; wave 15 owns re-tuning |

## 16. Housekeeping

- Scratch (all under `work/tmp/wardrobe/`): `retarget.mts`, `compose.mts`, `mask.py`, `make_sheet.py`, `glbinfo.mts`,
  `dumptex.mts`, `stats.mts`, `item.mts`, `npcs*.mts`, `meshy/` (runner, ledger, RT1/T1a/T1b outputs), `lab/` (Vite
  config, page), `proto/` (four glbs), `tex/`, `masks/`, `shots/` (7 PNG + 2 JSON), `wardrobe-preview.jpg`.
- Meshy: 3 jobs, 40 credits, NIGHT_LOG rows 07:03–07:08. Balance 1,690.
- The lab: Vite on :5297 (stopped), one Browser-pane tab (closed); no game server; no GPU lock (no timing taken).
- The fact-check pass: no file outside `docs/WARDROBE.md` written except a scratch script and a crop in the session's
  own temp folder; `material-budgets.test.ts` re-run read-only; no Meshy job, no browser, no server, no GPU lock.
