# Movement spec: jump (Space) (jump only 2026-09-29), keyboard movement (§13)

**Status (wave 10r, built 2026-10-01):** the jump is built as MV-P, MV-A and MV-C (MV-L was cut): Space jumps in place and while running, the server validates and broadcasts it (cosmetic, no position change), a mounted jump is refused with a toast, and a trade stays open through it. The dodge roll stays deferred (BACKLOG). **P-JUMP (2026-10-01):** after trying it the user said "jumping needs to be a bit higher": every clip now lifts about 0.6 m (was 0.2–0.3 m) with the 700 ms of air that gravity gives for that height (§3.2 "The higher jump").

The user asked for it on 2026-09-28 (BACKLOG item 5). On 2026-09-29 they ordered "jump and dodge roll, with new
animations made in Blender", and later that day redefined the next wave. Item 3 of that list is now **"Jump (Space)
only, with polished animations made in Blender"**. The dodge roll is deferred (work/tmp/w9-user-decisions.md, "the
NEXT WAVE, redefined by the user").

**(jump only 2026-09-29)** This revision:

- drops the roll from this wave. Its design is kept, unchanged in substance, in the appendix "Deferred: the dodge
  roll";
- re-keys the prototype JUMP with the polish applied, and adds a first running jump (JUMP_RUN), both on the male
  skeleton (§3.2);
- narrows the server rules, the protocol, the client, the budgets, the lanes, the tests and the cut order to the jump.

This spec covers:

- what the retail animation data already has, and what it lacks (§1);
- how the new animations are made, with the working prototype and its polish (§2, §3);
- the gameplay rules: server authority, cooldown, locks (§4);
- the protocol additions (§5), the client (§6), and budgets per preset (§7);
- lanes, tests, user checks and the scope-cut order (§8 to §10);
- what the user must decide, and open questions with defaults (§11, §12).

It is a design only. Nothing under `packages/`, `apps/`, `content/` or `deploy/` was edited. The scratch prototype
lives in `work/tmp/movement/`, and the polish pass in `work/tmp/movement/polish/`.

**Tags.**

- **[confirmed]**: checked in code at HEAD `fcbdf92` (plus the release workflow's uncommitted edits), in the extracted
  retail data, or measured by the prototype. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: a number scaled from a measurement.
- **[unknown]**: open. The default is given.

**Fact-check pass (2026-09-29).** An adversarial re-check re-derived every [confirmed] claim of the jump + roll draft
from code, data and re-runs. The corrections are made in place, and each one is listed in the appendix "Fact-check
log". The scratch files for the pass are in `work/tmp/movement/factcheck/`. The jump-only revision re-checked the
seams it still uses (§4.1) at HEAD `fcbdf92`.

**Second fact-check (jump only, 2026-09-29 night).** A second adversarial pass re-derived the jump-only revision's
[confirmed] claims against the code at HEAD `fcbdf92` plus the release workflow's uncommitted edits, the polish data,
and re-runs (NullEngine bench, brotli, a new foot-contact sampler of every RUN variant). Its corrections are marked
**(fact-check 2)** in place and listed as items 23–38 of the log. Its scratch files are in
`work/tmp/movement/factcheck2/`. The biggest one: the prototype JUMP_RUN was built on the **fist** RUN, which only an
unarmed male plays; every armed character runs a different 0.666 s cycle (§1.1, §3.3, §6.2).

---

## 0. Summary

- **Retail has no jump.** None of the 536 Chinese character `.ban` files is one [confirmed: every file listed and its
  root motion scanned, §1]. What retail does have is a **leap** inside some weapon skills. It gives the timing
  reference: crouch 166 ms, take-off ~200–233 ms, about 0.5 s in the air, 1.37 m apex. Nothing is reused as-is.
- **Animation route: hand-keyed in Blender with bpy scripts on the retail skeletons.** There are only two skeletons:
  `europeman_skel` serves all 13 Chinese male models and `europewoman_skel` all 13 female ones [confirmed: sidecar
  `animationPacks.skeleton`]. **(jump only 2026-09-29)** That makes **4 clips**: JUMP (standing) and JUMP_RUN
  (running), one pair per skeleton.
- **The polished prototype works end to end** **(jump only 2026-09-29)** [confirmed: every step re-run, §3.2]:
  1. the key poses are JSON files (`polish/keys/jump.json`, `jump_run.json`), which is the proposed committed format;
  2. `polish/key_moves.py` keys both clips headless in Blender 5.2, enforces the foot contacts on every frame, and
     exports glTF;
  3. `polish/make_pack2.py` re-expresses them into our pack format. The retail STAND1 control comes back within
     0.031° and 7.8e-7 m;
  4. a Babylon 9.28 page retargets the pack onto the converter's `chinaman_adventurer.glb` by joint name, with 0
     joints unmapped (47 and 48 channels), and captures the frames.

  Outputs: `polish/out/jump_filmstrip.png`, `jump.gif`, `jump_run_filmstrip.png`, `jump_run.gif`, and
  `jump_before_after.png` (the first prototype against the polish, same camera).
- **The polish the user asked for is in** [confirmed: `polish/out/man/moves_keys.json`, the filmstrips]:
  - take-off at **200 ms** (was 400 ms);
  - a push **toe-roll** (the heel lifts, the ball stays planted);
  - **arms** that swing back in the crouch, swing forward at take-off, open to the sides at the apex and come forward
    for balance on landing (the first prototype held them stiffly forward from 300 to 733 ms).
    **(fact-check 2)** At take-off and rise (200–267 ms) the arms are still straight forward at shoulder height: 96–102°
    of flexion with 10–14° of elbow [confirmed: the §3.2 table, `jump_filmstrip.png` frames "take-off" and "rise"]. So
    the stiff forward silhouette is shorter (about 70–100 ms instead of 430 ms) but not gone. It is touch-up 1 of §3.2;
  - a **ball-then-heel landing** with a deep absorb and a small rebound.

  The standing JUMP is 1.10 s, with 433 ms in the air and a pelvis apex of 1.31 m. **(P-JUMP 2026-10-01)** Now
  1.37 s, with 700 ms in the air and a pelvis apex of 1.61 m (§3.2 "The higher jump").
- **A first running jump:** JUMP_RUN is a 1.00 s stride leap. It starts at the retail fist RUN's right-foot contact and
  pushes off the right foot at 200 ms. It lands on the left foot at 600 ms and runs on into the fist RUN's phase 0, where
  the base RUN restarts seamlessly. The stance foot follows RUN's own foot track within 0.7 mm per frame.
  - **(fact-check 2) It only fits an unarmed male.** The prototype's base is the `default` group's RUN (0.8 s). An
    armed male runs `RUN_chinaman_fighter_runforward_sword`, `RUN_spear_run_fighter` or `RUN_bow_run_fighter`: 0.666 s
    cycles that share one leg track within 3.2 cm and start at **left** mid-stance, with the right contact at about
    0.30–0.37 s [confirmed: sidecar durations; `factcheck2/family_run_feet.py`]. For them the "seamless" exit becomes
    a leg swap, and the entry seek rule does not apply. JUMP_RUN is therefore authored per **RUN leg cycle**, not per
    skeleton (§3.3).
- **Female skeleton [confirmed]:**
  - The standing JUMP key file transfers to `europewoman_skel` unchanged: planted within 0.14 mm, apex 1.27 m.
  - **JUMP_RUN does not transfer.** Her RUN cycle is 0.667 s and starts at left mid-stance. The male fist RUN is 0.8 s
    and starts at right-foot contact. **(fact-check 2)** Her cycle has the same shape as the armed male's (both 0.666 s,
    starting at left mid-stance), so the armed-male clip is the better starting point for hers (§3.3).
- **Gameplay: the jump is cosmetic.** It never changes the server position or the current move, so it can never cross
  a nav edge. The rules:
  - a 1 s cooldown, checked on the server with a 150 ms slack for network jitter **(fact-check 2)**;
  - rate limit 2/s, burst 3;
  - refused when dead, mounted, stalling, stunned/frozen/knocked down, or casting (in that order, §4.2);
  - **(fact-check 2)** allowed while trading, like `emote` (it goes on `TRADE_ALLOWED`, §4.3);
  - a sitter stands up first.
- **Protocol (jump only 2026-09-29):** 1 client request (`jump`) and 1 server event (`jump {id, at}`). There is no
  `roll` and no `MoveState.style`, and the `connection.ts` / `onMoveTo` seams are gone.
- **Cost:** no GPU, no shaders, no new draws. That matters in a wave whose item 1 is cutting draws.
  - CPU for 20 actors all jumping every 1.3 s is +0.20 ms mean and +0.47 ms p95 per frame, or +0.44 / +0.70 ms with
    the masked arm layer [confirmed: NullEngine bench, §7].
  - The polished clips have the same channel count as the prototype (47 and 48), and a re-run of the bench on them
    measured the same cost within the noise of a loaded machine [confirmed, §7].
  - Download is 34.6 KB per skeleton for both clips with brotli [confirmed]. **(fact-check 2)** With the per-cycle
    JUMP_RUN (§3.3) the male pack holds 3 clips, about 52 KB with brotli [projected]; the female stays about 38 KB
    [confirmed for 2 clips].

---

## 1. Retail animation inventory

### 1.1 What exists

- **Files.** `work/extracted/Data/prim/ani/char/china/man` holds 282 `.ban` files and `.../woman` holds 254
  [confirmed: `ls`]. `work/tmp/movement/list-bans.ts` parses all 536 with our `@sro/formats` parser. It lists the
  duration, key count, loop flag and the Bip01 root motion (rise, drop, XZ travel in metres), and whether our converted
  models use each file. Output: `work/tmp/movement/bans.txt` and `bans.json`.
- **Use.** The converted Chinese models use 377 of the 536 files [confirmed: same script].
- **Clip groups.** The male adventurer carries 225 clips in 9 aniGroups [confirmed: sidecar
  `work/out/char/china/chinaman_adventurer.json`]:
  - `default` (fists: stand, walk, run, attacks, damage, die, sit, emotes 01–08, down/wakeup, stun, pickup, cast);
  - `sword` (sword and blade share it: models.ts `FAMILY_CLIP`);
  - `spear` (spear and glaive);
  - `bow`;
  - `cart` (the rider pose on a horse or cart);
  - `avatar_wing`;
  - `avatar_nasrun1`–`avatar_nasrun3`.
- **No jump.** The names were searched for jump, roll, dash, leap, evade, dodge, tumble, flip, hop, slide, fall, fly,
  step, blink, ride and horse [confirmed: grep over all 536 names]. The "fly" hits are the unused
  `s_fly_geomgang`/`geomin` and the used `man_avatar_fly`, which is the avatar-wing hover loop: 2.67 s, 0.20 m of rise
  [confirmed: `bans.txt`, re-listed by the fact-check].
- **Root-motion scan.** The root motion was also scanned. Every clip whose Bip01 rises more than 0.3 m is one of these
  [confirmed: `bans.txt`, the fact-check's re-filter]:
  - a weapon skill;
  - the knockdown `a_down`;
  - a stand-up (`a_sitstand` and its variants, `a_wakeup`, `reborn`);
  - one of two unused `spidey_*` clips in the male folder, whose purpose is [unknown].
    - `spidey_attack01` is a small leap: crouch −0.35 m at 133 ms, apex 1.16 m at 366 ms.
    - `spidey_move` is a 3.7 s loop that bobs up to 3.7 m.
- **The retail RUN** (the base under JUMP_RUN) **(jump only 2026-09-29)** [confirmed: `polish/run_feet.py`,
  `run_feet_w.py`, sampled at 30 fps from the converter's glbs]:
  - **Male:** a 0.8 s cycle. The right toe is planted from 0 to ~0.2 s, sliding back from +0.45 m to −0.52 m, which is
    4.85 m/s against the server's 5.5. Flight is 0.2–0.4 s, the left stance 0.4–0.6 s, and flight again to 0.8 s.
    The pelvis moves between 0.88 and 0.96 m.
  - **Female:** a 0.667 s cycle that starts at **left mid-stance** (left toe at +0.03 m at t = 0). The right stance is
    ~0.30–0.40 s.
- **(fact-check 2) The RUN a character actually plays depends on its weapon** [confirmed: sidecar `animations`
  durations; `models.ts clipFor` prefers the family's `RUN_*` variant; `entities.ts weaponFamily()` is undefined only
  with no weapon equipped; foot tracks from `work/tmp/movement/factcheck2/family_run_feet.py`, output
  `family_run_feet.json`]:

  | Skeleton | RUN clip (weapon) | Cycle | t = 0 | Right contact | Leg track vs the first clip of its row group |
  |---|---|---|---|---|---|
  | male | `RUN` (none: fists) | 0.800 s | right contact | 0–0.2 s | — |
  | male | `RUN_chinaman_fighter_runforward_sword` (sword, blade) | 0.666 s | **left mid-stance** | ~0.30–0.37 s | reference |
  | male | `RUN_spear_run_fighter` (spear, glaive) | 0.666 s | left mid-stance | ~0.30–0.37 s | within 2.1 cm |
  | male | `RUN_bow_run_fighter` (bow) | 0.666 s | left mid-stance | ~0.30–0.37 s | within 3.2 cm |
  | female | `RUN` (none) | 0.666 s | left mid-stance | ~0.30–0.40 s | reference |
  | female | `RUN_chinawoman_merchant_runforward_sword` | 0.666 s | left mid-stance | ~0.30–0.37 s | within 2.6 cm |
  | female | `RUN_spear_run_merchant` | 0.666 s | left mid-stance | ~0.30–0.37 s | 16 cm apart |
  | female | `RUN_bow_run_merchant` | 0.666 s | left mid-stance | ~0.33–0.40 s | 22 cm apart |

  So an armed male (the normal case: every starter class has a weapon) runs the same kind of cycle as a female, and
  the 0.8 s fist RUN that the prototype used is the exception.

### 1.2 What could be reused, and the verdict

| Retail clip | What it is | Measured (Bip01, m) | Verdict |
|---|---|---|---|
| `skill_ch_sword_downattack_b`, `skill_ch_spear_stun_b`/`_e`, `spear_downattack_b` (M/W) | A weapon skill with a vertical leap | Crouch −0.33 at 166 ms, takeoff 200–233 ms, apex **1.37 m at 466 ms**, lands at ~709 ms (≈ 0.5 s airborne), then a −0.45 m slam crouch [confirmed: `root-curve.ts`] | **Timing reference only.** The arms swing the weapon, and the slam is not a landing. Our JUMP copies its rhythm at a lower apex. |
| `chinaman_a_down` + `chinaman_a_wakeup` (DOWN, DOWN_UP) | Knockdown onto the back, then get-up | Down: up 0.64, then down −0.79 in 1.0 s. Wakeup: 0.67 s, rising 0.79 m [confirmed] | Not a jump. |
| `chinaman_a_sitstand`, `chinaman_reborn` | Stand up from sitting or death | Rise 0.9–1.0 m [confirmed] | No. |
| `chinaman_return`, `return1`, `return_sword_l`/`_r` (unused) | A 500 ms hop in place | Rise 0.07, travel 0.15 [confirmed] | Too small. Purpose [unknown]. |
| `chinaman_s_fly_geomgang`/`geomin`, `s_light_cho`/`jil`, `s_cool_vingha` (unused) | Unused skill clips ("fly", "light" names) | No rise; `s_light_cho` loops with 0.09 m bob [confirmed] | No. |
| `cm_emot_act_rush` (EMOTION03, emote `rush`) | Emote | Travel 0.46 [confirmed] | No. |
| `spidey_attack01`, `spidey_move` (male folder, unused) | [unknown]: not a character skill by name | Attack: crouch −0.35 at 133 ms, apex 1.16 m at 366 ms. Move: a 3.7 s loop, apex 3.7 m [confirmed: `root-curve.ts`, fact-check] | No. A second timing reference only: take-off at ~200 ms, like the weapon leap. |
| `cart_stand01`, `cart_walk` (group `cart`) | The rider pose on the horse | — | There is no horse-jump clip [likely: none by name]. A mounted jump is refused (§4.3). |

**Conclusion [confirmed]:** the jump needs new clips: 2 per skeleton × 2 skeletons **(jump only 2026-09-29)**.

- Female models add two joints under `Bip01 Spine1` (`Bone01` → `Bone02`), 45 joints in all [confirmed: glb node
  tree]. They are most likely a ponytail or cloth chain [likely]. The clips key them from the base pose (no hand keys).
- **The thighs are children of `Bip01 Spine`, not of `Bip01 Pelvis`**, on both skeletons **(jump only 2026-09-29)**
  [confirmed: glb node tree, `polish/` check]. A spine lean therefore rotates the legs too, and the keyer must pose the
  legs in absolute terms (§3.2).

---

## 2. Animation route

### 2.1 The three routes

| Route | How | Pros | Cons | Needs from the user |
|---|---|---|---|---|
| **A. Hand-keyed bpy (chosen by the user 2026-09-29, prototyped and polished)** | A script poses the retail skeleton from key-pose JSON: world-space limb angles, per-frame foot contacts, a parabolic air arc. It keys the frames and exports | Deterministic and reviewable, because the key poses are numbers in a JSON. Matches the retail style (sparse hand keys at 30 fps: STAND1 has 14 keys, RUN 13 [confirmed: sidecar `keys`]). No download, no upload, runs in ~15 s headless for 2 clips [confirmed] | Programmer-art quality unless someone touches it up in the Blender UI. Each clip took ~1–2 hours of iteration [confirmed for the polish pass] | The look approval (§11) |
| B. Free/CC0 mocap retargeted | Download a CC0 BVH set, retarget in Blender, bake, then the same pack step as A | Natural weight and timing | Style mismatch with the stiff retail clips; retarget cleanup; foot sliding on 2005-era proportions | Approval of each **download** (library, licence, size) |
| C. AI motion (text-to-motion) | A prompt produces SMPL/FBX motion, retargeted as in B | Fast variety | Quality varies; licence and service terms; credits. **Nothing retail is uploaded** (a text prompt only) | Approval of the service and the credits |

**Decision: route A** (the user: "Yes, polish the animation", 2026-09-29, and "polished animations made in Blender").
B stays the fallback if the user rejects the look at the §9 check. All three routes end in the same step (§2.2), so
switching later changes no code.

### 2.2 The pipeline (all routes)

```
content/moves/<skel>/<clip>.json     key poses (text, committed; no retail data): absolute angles on the idle, or deltas
        │                            on the retail RUN at a named phase; contacts, air arc, events (§3.2 has the schema)
        │  Blender 5.2 headless: packages/convert/tools/blender/moves/key_moves.py <char.glb> <out> <prefix>
        │  (the Blender path comes from the sro.config.json key `blenderExe`, which COAST.md's CST-B lane adds)
        ▼
work/out/moves/<skel>/moves_blender.glb   Blender's glTF export (armature + meshes; rest frames re-oriented)
        │  pnpm sro moves   (packages/convert/src/tools/export-moves.ts; the maths of polish/make_pack2.py)
        ▼
work/out/char/_anims/<skel>/movement.glb    pack format (docs/ASSETS.md §5.3): the skeleton's joints, same names and
work/out/char/_anims/<skel>/movement.json   rest TRS; clips <prefix>_jump, <prefix>_jump_run; the index with events
        │  optimize-out: meshopt + .br like every other pack (pass-through, §8 MV-A)
        ▼
out-opt/char/_anims/<skel>/movement.glb     loaded by three/models.ts with the actor's `default` pack
```

- **One Blender tooling home.**
  - COAST.md's lane CST-B puts its Blender scripts in `packages/convert/tools/blender/*.py`. It also adds a
    `blenderExe` key to `sro.config.json`, read by `packages/convert/src/tools/coast-blender.ts` [confirmed: COAST.md
    lane table].
  - MV-A uses the same folder (a `moves/` subfolder) and the same key.
  - **(jump only 2026-09-29)** The coast is now in the **same wave** (the user's item 2), so both lanes may want the
    key at once. Whichever lands first adds it, with the name `blenderExe` and the default
    `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`. The other rebases (§8.1 seams).
- **Where the packs live today.** The per-skeleton packs exist only in the optimizer's output,
  `work/out-opt/char/_anims/<skel>/`, as 16 packs for the male skeleton (**(fact-check 2)**: `default`, `sword`,
  `spear`, `bow`, `cart`, 4 avatar packs and 7 other weapon packs; the draft said 14). The optimizer builds them from the clips
  embedded in `work/out/` [confirmed: `ls`]. `work/out/char/_anims/` does not exist yet, so `pnpm sro moves` creates
  it.
- **Nothing retail is committed.** `*.glb` is git-ignored and `work/` is private [confirmed: `.gitignore`]. A `.blend`
  holding the retail mesh is retail data, so it stays in `work/` too.
- **What is committed** is the key-pose JSON (our own authoring) and the scripts.
  - Hand edits made in the Blender UI are written back to JSON by `extract_deltas.py`: per key frame and bone, the
    world sagittal angles the keyer uses, plus the root offset.
  - A touch-up that cannot be expressed that way (a finger curl, a twist) is stored as a per-bone local rotation delta
    on that key, in an optional `extra` field.
- **The movement index.** `movement.json` is a small per-skeleton index:
  `{ clips: { JUMP: { anim, durationMs, fps, events } } }` [confirmed: `polish/out/man/movement.json` is written in
  this shape].
  - **(fact-check 2)** It also gets `air`: the lowest foot contact per 1/30 s (34 numbers for JUMP, from the keyer's
    `lowZ`). The entity root never leaves the ground (§4.2), so without it no other part can know how high the feet
    are. GRASS_LIFE needs exactly that: its player push "fades out above 0.5 m of height over the ground" (GRASS_LIFE
    item-3 seam), and it reads the entity position, which a jump never lifts [confirmed: `entities.ts update` puts the
    root on `heightAt`]. MV-C exposes `jumpLift(view, now)` (metres, 0 when not jumping) from `air` and the clip
    cursor, so there are no bone reads.
  - With the per-cycle JUMP_RUN (§3.3) the index maps each RUN clip name to its JUMP_RUN:
    `runJumps: { "RUN": "JUMP_RUN_FIST", "RUN_chinaman_fighter_runforward_sword": "JUMP_RUN", … }`. `models.ts` finds it from the actor's `animationPacks.skeleton` (slim) or the basename of `skeleton.bsk`
  (unslimmed `/out/`). The 26 character sidecars and the optimizer's pack builder therefore stay untouched: only a
  copy step is added.
- **Events** use the retail sidecar event shape (`{timeMs, type: 2, p1, p2}`, the footstep events of RUN
  [confirmed: sidecar RUN has two type-2 events]). They carry the take-off and landing: JUMP at 200 / 633 ms, and
  JUMP_RUN at 200 / 600 ms [confirmed: `movement.json`].
  - **The game's footsteps do not come from sidecar events** [confirmed: code]. `audio/entity.ts` plays the per-model
    `ModelSounds.clips` tracks, which come from the sound export and are keyed by clip name
    (packages/shared/src/sound.ts). `audio/surface.ts` only answers "which surface is under this point".
  - The movement clips have no tracks there. MV-C therefore turns the index events into `ClipTrack`s for JUMP and
    JUMP_RUN: a footstep by surface at take-off and landing, in `audio/entity.ts` or `audio/cues.ts`.

---

## 3. The prototype and its polish

### 3.1 The first prototype (2026-09-29 morning; kept for reference)

All files are in `work/tmp/movement/`. Every step was run for real.

| Step | File | Result |
|---|---|---|
| 1. Key the jump in Blender (headless) | `blender/key_jump.py` | Imports `work/out/char/china/chinaman_adventurer.glb` (43 joints, 225 actions). Takes STAND1 frame 0 as the base, keys 9 poses at 30 fps, and saves `out/jump.blend` and `out/jump_blender.glb` [confirmed] |
| 2. Pack it | `blender/make_pack.py` | `out/movement.glb`: 43 joint nodes, 1 clip `chinaman_jump`, 39 keys, 1.267 s, 47 channels, **48,224 bytes** uncompressed [confirmed] |
| 3. Load it in a scratch viewer | `viewer/main.ts` (esbuild bundle of the repo's own Babylon 9.28), `viewer/serve.py` (private port 5197, stopped after) | Retargets the clip by joint name exactly as docs/ASSETS.md §5.3 shows: **0 unmapped** of 47. Renders fixed frames [confirmed] |
| 4. Clip and screenshot | `viewer/sheet.py` | `out/jump_filmstrip.png` (15 frames, 0–1266 ms) and `out/jump.gif` [confirmed] |

Its key poses: stand 0 ms, crouch 200 ms, push 300 ms, take-off **400 ms**, apex 566 ms (pelvis 1.318 m), fall 733 ms,
touch 833 ms, absorb 966 ms, stand 1266 ms [confirmed: `out/jump_keys.json`]. What the user saw and asked to polish:

- **Take-off late.** The prototype leaves the ground at 400 ms. The retail leap and `spidey_attack01` leave at ~200–233
  ms, and a 400 ms crouch on a key press reads as input lag.
- **Stiff forward arms.** From 300 to 733 ms the arms are held straight forward at shoulder height [confirmed:
  `out/jump_filmstrip.png`]. The causes, found in the polish pass [confirmed: `blender/key_jump.py` against the glb
  node tree]:
  - the upper arms swung 55–80° forward with only 10–30° of elbow bend and no sideways (abduction) component;
  - the per-bone sign test that picks the rotation direction is ambiguous for a bone that already points forward (the
    forearm after an 80° swing, and the foot). So the elbow bend and the foot compensation could go either way;
  - the spine lean was applied before the legs, and the thighs are children of `Bip01 Spine`, so the lean leaked into
    the legs.
- **Flat feet at take-off** (no toe-roll), and a landing on flat feet with a plain crouch.

### 3.2 The polish pass **(jump only 2026-09-29)**

All files are in `work/tmp/movement/polish/`. Every step was run for real on the male skeleton; the female re-run is in
§3.3.

| Step | File | Result [confirmed] |
|---|---|---|
| 1. Key poses as data | `keys/jump.json`, `keys/jump_run.json` | 13 key poses for JUMP, 10 for JUMP_RUN: angles per limb, lean, head, contacts, air arc, events |
| 2. Key both clips in Blender (headless) | `key_moves.py <char.glb> <out> <prefix>` | ~15 s for both clips. Saves `out/man/moves.blend`, `moves_blender.glb` and `moves_keys.json` (per-frame pelvis height, lowest contact, planted-foot slide, root offset, hand positions) |
| 3. Pack it | `make_pack2.py <char.glb> <out> <prefix>` | `out/man/movement.glb` holds 43 joint nodes and 2 clips: **78,436 bytes** raw, **34,564 bytes** with brotli q11 (`br2.ts`). It also writes the index `movement.json` and `roundtrip.json` |
| 4. Load, retarget, capture | `viewer/main2.ts` (esbuild of the repo's Babylon 9.28), `viewer/serve2.py` (private port 5198, stopped after), `viewer/capture.sh` (headless Chrome with a scratch profile, closed after each capture) | 0 unmapped of 47 (JUMP) and 48 (JUMP_RUN) channels. JUMP is 44 frames with STAND1 holds; the running capture is 55 frames: RUN, then JUMP_RUN, then RUN, over a checker ground scrolled at 5.5 m/s |
| 5. Sheets and GIFs | `sheet2.py` | `out/jump_filmstrip.png`, `out/jump.gif`, `out/jump_run_filmstrip.png`, `out/jump_run.gif`, `out/jump_before_after.png` |

**What the keyer now does** (each one fixes something in §3.1):

1. **Absolute limb angles with one rotation sense.** Each limb bone is aimed so that the vector to its child has a
   target **sagittal angle** (0° = straight down, +90° = forward). The angle is the idle's angle plus the key's value.
   One rotation sense S, found once from the thigh, is used for every limb bone. So the spine lean no longer leaks into
   the legs, and a bone that points forward can no longer flip its bend.
2. **Arms:**
   - `[swing, elbow, abduct]` per side: shoulder flexion, elbow bend and sideways opening. Abduction is applied first
     (about the forward axis, the hand moving outward), then the sagittal swing;
   - the two sides differ by 2–6° and the forearms lag the upper arms, so they are never mirror-stiff.
3. **Toe-roll.** `[thigh, knee, foot, toe]` per leg. A negative foot angle points the toes down, which lifts the heel,
   and a positive toe angle bends the toe joint back, which keeps the ball flat on the ground.
4. **Contacts on every frame, not only on keys.**
   - A virtual heel sits 3 cm behind the ankle at ground height, fixed in the foot's frame.
   - On planted frames the root is moved so that the lowest of toe ball and heel is on the ground.
   - The feet are locked horizontally: to their start positions for JUMP, or to the retail RUN's own toe track for
     JUMP_RUN.
5. **Air arc.** Between take-off and touch-down the root follows `lerp(root_takeoff, root_touch, u) + 4·H·u·(1−u)`,
   a parabola with the hang at the apex. There is a guard that keeps both feet ≥ 1 cm above the ground.
6. **Interpolation.** Quaternion keys keep hemisphere continuity. Every rotation key uses AUTO (unclamped) Bezier
   handles, so poses flow through the keys instead of easing to a stop at each one.

**The higher jump (P-JUMP, 2026-10-01)** [confirmed: `pnpm sro moves`, 0 failed checks; `work/out/moves/<skel>/
moves_keys.json` and `roundtrip.json`; filmstrips and a before/after GIF in `work/tmp/w10p/jump/`
(`chinaman_filmstrip.png`, `chinawoman_filmstrip.png`, `jump-higher.gif`, also in Dropbox `wave10/jump-higher.gif`)].
The user, after trying the jump: "jumping needs to be a bit higher". The decision (delegated): **double the lift**, from
`apexRiseM` 0.3 (standing) / 0.22 (running) to **0.6 m** for every clip, with the air time a real body needs for that
height: 2·√(2·0.6 / 9.81) = 0.699 s, so **21 frames = 700 ms** (was 13 and 12). The parabola is unchanged (§3.2 step 5),
so the take-off and touch-down speeds (3.4 m/s) now match the push and the absorb better than before (2.8 m/s).

- **Standing JUMP** (both skeletons, one key file): 42 frames, **1.37 s** (was 34, 1.10 s). The crouch, the toe-roll
  push and the take-off at **200 ms** are unchanged (so `JUMP_MAX_SEEK_MS` still stops at the take-off), and so are the
  arms that drive up past the head. In the air: rise at 300 ms, apex tuck at 500 ms, a new **hang** key at 633 ms that
  holds the tuck around the apex (otherwise the longer arc reads floaty), fall at 767 ms, **touch-down (ball) at
  900 ms**, heel at 933 ms, then a slightly deeper **absorb** at 1000 ms (thigh 50 / knee 96, lean 26; was 47 / 90 /
  24) for the harder landing, rebound 1133 ms, settle 1233 ms, stand 1367 ms.
- **Running jumps** (JUMP_RUN man and woman, JUMP_RUN_FIST): the same 0.6 m and 700 ms; take-off unchanged (133 ms
  weapon cycle, 200 ms fist), a **hang** key after the apex split, the landing and run-on keys 9 frames later on the
  **same RUN phases**, so `enterPhaseS`/`exitPhaseS` and the hand-back to the RUN are unchanged (feet 0.00 cm at both
  ends on the keyed RUNs). The landing absorb is a little deeper (left knee delta 20° on JUMP_RUN, 24° on JUMP_RUN_FIST; was 18°). JUMP_RUN is 1.17 s
  (man) / 1.13 s (woman), JUMP_RUN_FIST 1.30 s; touch-down at 833 ms (weapon/woman) and 900 ms (fist).

| Clip | Frames / ms | Air (take-off → touch) | Pelvis first frame → apex (lift) | Feet clear | Hands peak | Slide max | Air min | Raw bytes |
|---|---|---|---|---|---|---|---|---|
| man JUMP | 42 / 1367 | 200 → 900 ms | 0.998 → **1.610** (0.61; was 1.311) | 0.887 m | 2.20 m | 8.8 mm (heel-down, as before) | 0.000 | 31,080 |
| woman JUMP | 42 / 1367 | 200 → 900 ms | 0.955 → **1.568** (0.61; was 1.268) | 0.861 m | 2.09 m | 9.3 mm (heel-down, as before) | 0.000 | 33,432 |
| man JUMP_RUN | 36 / 1167 | 133 → 833 ms | 0.901 → **1.482** (0.58; was 1.107) | 0.967 m | 2.13 m | 0.1 mm | −0.007 | 28,800 |
| man JUMP_RUN_FIST | 40 / 1300 | 200 → 900 ms | 0.919 → **1.497** (0.58; was 1.127) | 0.940 m | 2.09 m | 0.1 mm | −0.010 (the RUN's own contact depth) | 30,560 |
| woman JUMP_RUN | 35 / 1133 | 133 → 833 ms | 0.929 → **1.489** (0.56; was 1.112) | 0.998 m | 2.04 m | 0.0 mm | 0.000 | 29,120 |

Planted contacts ≤ 0.01 mm on every clip, the STAND1 control within 0.0016° and 8.0e-7 m, the pack within 1.7e-5 m of
Blender's export, root XZ excursion ≤ 0.119 m, 0 at the ends. The packs grow with the frames: man 127,552 B raw /
61.8 KB brotli q11 (was 106,464 / 48.8 KB), woman 91,812 B / 42.2 KB (was 77,952 / 33.9 KB) [confirmed]; the per-frame
CPU cost does not change (the same channels are sampled). **Cooldown:** `JUMP_COOLDOWN_MS` stays **1000**: the last
touch-down is at 900 ms, so the next jump (pressed ≥ 1000 ms later) starts its crouch during the landing absorb and
never cuts a jump in the air (pinned in `moves.test.ts`). **Client:** no code change. It reads the take-off, the
landing and the durations from the index (`moveEventTimes`), so the "air part plays over a move" window (§6.2) grows
to 700 ms by itself. The tables below are the 2026-09-29 polish, kept for reference.

**The polished standing JUMP** (male, 30 fps, 34 frames, 1.10 s; **before P-JUMP**) [confirmed: `out/man/moves_keys.json`,
`roundtrip.json`]:

| Frame | ms | Pose | Legs (thigh / knee / foot / toe, °) | Arms L/R (swing / elbow / abduct, °) | Lean ° | Pelvis (m) | Lowest contact (m) |
|---|---|---|---|---|---|---|---|
| 0 | 0 | stand | 0 / 0 / 0 / 0 | 0 / 0 / 0 | 0 | 0.998 | 0.001 |
| 3 | 100 | **crouch** | 44 / 82 / 0 / 0 | −48 / 30 / 8 and −52 / 24 / 8 (arms back) | 24 | 0.738 | 0.001 |
| 5 | 167 | **push, toe-roll** | 22 / 36 / **−24 / +24** | 36 / 34 / 6 and 42 / 28 / 6 (driving forward) | 12 | 0.968 | 0.001 (ball) |
| 6 | 200 | **take-off** | 4 / 6 / −46 / +28 | 96 / 12 / 12 and 100 / 10 / 12 (forward at shoulder height, nearly straight; **(fact-check 2)** not "up": 90° is horizontal) | 3 | 1.040 | 0.001 (ball) |
| 8 | 267 | rise | 22 / 46 / −30 / 8 | 98 / 14 / 24 and 102 / 12 / 24 (still rising: overlap) | 0 | 1.187 | 0.246 |
| 12 | 400 | **apex** (knees tucked) | 58 / 88 / −12 / 0 | 50 / 30 / **58** and 54 / 28 / 56 (opened to the sides) | 6 | **1.311** | **0.568** |
| 16 | 533 | fall | 30 / 40 / −26 / 0 | 30 / 30 / 52 and 33 / 28 / 50 | 4 | 1.207 | 0.250 |
| 19 | 633 | **touch (ball first)** | 18 / 26 / −12 / +12 | 22 / 28 / 38 and 24 / 26 / 36 | 8 | 0.981 | 0.001 |
| 20 | 667 | heel down | 30 / 56 / 0 / 0 | 30 / 40 / 26 and 32 / 38 / 24 | 14 | 0.867 | 0.001 |
| 22 | 733 | **absorb** | 47 / 90 / 0 / 0 | 40 / 52 / 18 and 42 / 48 / 18 (forward, for balance) | 24 | **0.693** | 0.001 |
| 26 | 867 | rebound | 10 / 17 / 0 / 0 | 10 / 26 / 8 and 12 / 24 / 8 | 6 | 0.981 | 0.001 |
| 29 | 967 | settle | 4 / 7 / 0 / 0 | −4 / 12 / 3 and −3 / 12 / 3 | 2 | 0.992 | 0.001 |
| 33 | 1100 | stand | 0 | 0 | 0 | 0.998 | 0.001 |

(Legs are shown for the left side; the right differs by 1–2°.)

**Checks** [confirmed: the same files]:

- **Air time:** 433 ms (200 → 633 ms), against ~480 ms for the retail leap and ~430 ms for the first prototype.
- **Planted frames:** the lowest contact is within 0.22 mm of the idle's ground contact on every planted frame, and the
  largest planted-foot slide is 9 mm in one frame. **(fact-check 2)** That frame is the heel-down at 667 ms, not the
  push (the push frames slide 2–5 mm) [confirmed: `moves_keys.json` `skateM`].
- **Root XZ excursion:** ≤ 0.12 m in the pack (0.119; Blender's own metric peaks at 0.125 at take-off). It returns to ≤ 7 mm at the end, and the clip ends
  on the idle pose, so the blend back is invisible.
- **Pack against Blender's export:** every joint within 1.7e-5 m. The STAND1 round-trip control is within 0.031° and
  7.8e-7 m, and the rest re-orientation angles are {90°, 120°} as before.
- **Shape:** the hands peak at 1.83 m above the ground (at the rise).

**The first JUMP_RUN** (male, 30 fps, 31 frames, 1.00 s) [confirmed: same files]:

| Frame | ms | Pose | Base | Pelvis (m) | Lowest contact (m) |
|---|---|---|---|---|---|
| 0 | 0 | contact R | RUN @ 0.0 s; **(fact-check 2)** lifted ~1 cm by the contact solve (RUN's own toe sits at −0.008 m, pelvis 0.919 m), so not quite "unchanged" | 0.929 | 0.001 (R) |
| 3 | 100 | load | RUN @ 0.1 s + right knee +14°, left thigh +16°, lean 6° | 0.858 | 0.001 (R) |
| 6 | 200 | **take-off R** | absolute: R leg −18 / 8 / −46 / +30 (toe-off), L knee drive 84 / 100; R arm forward-up 82 / 74, L arm back −44 / 52 | 0.930 | 0.001 (R ball) |
| 11 | 367 | **apex split** | absolute: L 70 / 54 (lead leg reaching), R −34 / 96 (trailing, tucked); arms opening (abduct 26–30°) | **1.125** | 0.442 |
| 15 | 500 | reach | absolute: L 44 / 20 (reaching for the ground), R −4 / 104 (coming through) | 1.061 | 0.243 |
| 18 | 600 | **land L** | RUN @ 0.4 s + left knee +10° | 0.884 | 0.001 (L) |
| 21 | 700 | absorb | RUN @ 0.5 s + left knee +18°, lean 8° | 0.834 | 0.001 (L) |
| 24 | 800 | drive on | RUN @ 0.6 s + left knee +6° | 0.948 | 0.048 |
| 27 | 900 | run | RUN @ 0.7 s | 0.952 | 0.112 |
| 30 | 1000 | run | RUN @ 0.8 s = phase 0, where the base RUN restarts | 0.919 | −0.008 (RUN's own contact depth) |

JUMP_RUN checks [confirmed]:

- **Air time:** 400 ms, against 200 ms for the retail RUN's own flight phase.
- **Height:** the pelvis rises ~0.2 m above the RUN's mean (0.92 m), and the feet clear the ground by up to 0.54 m.
- **Stance feet** follow the retail RUN's own toe track within 0.7 mm per frame. They slide back at RUN's authored
  4.85 m/s, not at the server's 5.5 m/s: the same ~12 % under-slide that retail running already shows.
- **Root XZ excursion:** ≤ 0.065 m, and 0 at both ends.
- **Channels:** 48. JUMP_RUN keys a root translation track more than JUMP's 47, because RUN's own root bob feeds it.
- **(fact-check 2) Scope of these checks:** all of them are against the male **fist** RUN (0.8 s), which only a male
  with no weapon equipped plays (§1.1). No JUMP_RUN exists yet for the 0.666 s weapon RUN that armed males play.

**How it looks** (`out/jump_before_after.png`, `jump_filmstrip.png`, `jump_run_filmstrip.png`; the user judges this,
§9):

- the crouch reads at 100 ms, and the arm swing drives the take-off;
- the toes point at take-off;
- the arms open outward at the apex and on the fall. That is the fix for the stiff forward arms;
- the landing reads as ball, then heel, then absorb.
- **Still to touch up in the Blender UI** (MV-A, [likely] ~1 hour each; the scripts' JSON round-trip keeps the edits):
  0. **(fact-check 2)** at take-off and rise (200–267 ms) both arms are straight forward at shoulder height (swing
     96–102°, elbow 10–14°): the silhouette the user called "stiff forward arms", for 3 frames. Default touch-up: drive
     them higher (about 140–150°) with 30–40° of elbow, or keep them lower and bent;
  1. at take-off and rise, the far forearm reads bent toward the head from a 3/4 camera;
  2. the hands keep the retail idle's loose fists;
  3. the head is only counter-rotated against the lean (no look up at the apex);
  4. JUMP_RUN's take-off arm is a tight fist-pump, and the split at the apex is modest.

### 3.3 The female skeleton **(jump only 2026-09-29)**

`key_moves.py` and `make_pack2.py` were re-run on `chinawoman_adventurer.glb` (prefix `chinawoman`) into
`polish/out/woman/` [confirmed: `moves_keys.json`, `roundtrip.json`]:

- She measures thigh 0.405 m and calf 0.447 m (the male: 0.406 and 0.473). The keyer measures these itself.
- **JUMP transfers unchanged:**
  - planted within 0.14 mm, apex pelvis 1.268 m, absorb 0.685 m;
  - 51 channels, because her pack also carries `Bone01`/`Bone02` and her root track;
  - her STAND1 control is within 0.030° and 7.6e-7 m;
  - rest re-orientation {90°, 120°}.
- **JUMP_RUN fails:** the lowest toe reaches −0.89 m and the root travels 0.82 m. The cause is RUN phase, not
  proportions (§1.1):
  - the key file names RUN phases in the male's seconds;
  - the keyer scales them to her 0.667 s cycle, but her cycle starts at left mid-stance, so "right-foot contact at
    phase 0" is false for her and the contact solver pulls the root down to a foot that is in the air.
- **Rule for MV-A:** JUMP_RUN is authored per ~~skeleton~~ **RUN leg cycle (fact-check 2)**, with the RUN phases named
  by contact rather than by seconds. `runPhase: "R-contact"` / `"L-contact"` is resolved by a script that finds the
  contact frames in **that RUN clip** (the `run_feet.py` measurement, generalised in `factcheck2/family_run_feet.py`).
  The standing JUMP key file is shared by both skeletons.
- **(fact-check 2) Which JUMP_RUN clips, in priority order** (§1.1 table):
  1. **male weapon cycle** (`JUMP_RUN`, keyed on `RUN_chinaman_fighter_runforward_sword`; spear and bow reuse it, their
     leg tracks are within 3.2 cm): every armed male. It is the common case and does **not exist yet**; it is MV-A's
     first JUMP_RUN;
  2. **female** (`JUMP_RUN`, keyed on her `RUN`; sword within 2.6 cm). Her spear and bow RUNs are 16–22 cm off, with the
     same contact phases: they start from it with the 0.25 blend and end with the 0.12 blend back to their own RUN
     [likely: acceptable; §9 check 2 looks at a spear woman]. It starts from the male weapon key file, since both
     cycles are 0.666 s and start at left mid-stance;
  3. **male fist** (`JUMP_RUN_FIST`, today's prototype): only an unarmed male. Cut 3 in §10 drops it (an unarmed man
     then uses the weapon-cycle clip with the blends).
- **Base phase at entry and exit.** A per-cycle clip starts at that cycle's right contact and ends on a phase of the
  same cycle; the index stores both (`enterPhaseS`, `exitPhaseS`), and the base RUN must then **resume at
  `exitPhaseS`**, not at 0. Today `playAction`'s end observer restarts the base with `play(currentBase, true)`, which
  starts it at `g.from` [confirmed: `models.ts playAction`, `play`, `startUnblended`]. So `playMove` passes a resume
  frame for the base (a seam in models.ts, §8.1), or each clip is keyed to end exactly on the cycle's phase 0 (the
  prototype's trick, which forces the clip length to a multiple of the cycle plus the entry offset).

**Findings that the production lanes must keep** (from §3.1, re-confirmed by the polish pass):

1. **Blender re-orients every joint's rest frame** [confirmed]. With `bone_heuristic='TEMPERANCE'`, 42 joints come
   back rotated by 120° and 1 by 90°. The positions are unchanged, within 5.8e-7 m. [confirmed: the fact-check re-ran
   `make_pack.py` as `factcheck/make_pack_check.py` and got the same pack byte for byte; `make_pack2.py` finds the
   same angle set on both skeletons.] So a Blender export is **not** in pack format, and its local keys cannot be
   applied to our actors as they are.
   - The re-expression, per joint:
     - C = inv(G_orig_rest) · G_exp_rest;
     - G_orig(t) = G_exp(t) · inv(C);
     - local = inv(G_orig_parent(t)) · G_orig(t).
   - It is verified two ways:
     - **Control:** retail STAND1, sent through the same Blender import/export and re-expressed, matches the
       converter's own STAND1 keys within 0.031° and 7.8e-7 m over 70 samples;
     - **Pack vs export:** the pack clip on the original skeleton puts every joint within 1.7e-5 m of Blender's own
       result.
2. **Babylon plays glTF clips on a 60 fps frame axis.** Code that seeks by frame must use seconds × 60, or
   `clip.durationMs` from the index [confirmed: both viewers].
3. **Blending from the bind pose shows a T-pose.** The movement clips must go through the same `playAction` path as
   everything else (the D25 `startUnblended` rule in models.ts), not a raw `start()` [confirmed: models.ts].
4. **Contacts must be solved per frame, not per key** **(jump only 2026-09-29)**. With AUTO Bezier handles, a
   key-only solve lets the feet float or sink between keys. The per-frame pass keeps planted contacts within 0.22 mm
   [confirmed: `moves_keys.json`].
5. **The thighs hang from `Bip01 Spine`**, so the legs must be posed in absolute world angles after any spine lean
   **(jump only 2026-09-29)** [confirmed: glb node tree].

---

## 4. Gameplay **(jump only 2026-09-29)**

### 4.1 How movement works today [confirmed unless tagged; re-checked at HEAD `fcbdf92`]

- **Click-to-move and hold-to-move only.** There is no WASD. The client sends `moveTo {x, z}`
  (`world/intents.ts`). The server (`connection.ts` → `Gameplay.onMoveTo` → `World.moveTo`) runs one straight
  `nav.walk` from its own live point. The walk **stops at the first blocking edge** and never slides or re-plans
  (docs/NAVIGATION.md §6.1).
- **The move on the wire.** The server broadcasts `move {from, to, speed, startedAt}`, where speed is the server
  config `moveSpeed` (env `MOVE_SPEED`, default 5.5 m/s) × GM `speedMul`. It sends `stop` on arrival. The tick is
  config `tickHz` (env `TICK_HZ`, default 10 Hz) [confirmed: config.ts].
- **The client waits for the server.** Every entity interpolates with `sampleMove` on the server clock, and the visual
  root sits on `WorldGround.heightAt` (entities.ts `update`).
- **Players never collide** with players or mobs (NAVIGATION §6.4) [likely].
- **The precedent: `emote`.** It is a GameplayRequest whose server event reuses the client `t` name
  (`{ t: 'emote'; id; emote }` to "its viewers (the sender included)"). It is refused `dead`, or `busy` while moving
  or casting, and it stands a sitter up first [confirmed: protocol.ts lines 385–386 and 642–643]. The jump follows
  this shape.
- **Wave-8 locks** are `GameplayModule.gate(p, t)` vetoes [confirmed: grep at HEAD]:
  - trade: `TRADE_ALLOWED` (social/trade.ts). **(fact-check 2)** It already lists `emote`, with the comment "an emote
    is harmless" (WAVE_PLAN2 §6.5, I8) [confirmed: trade.ts line 41–42];
  - stall: `STALL_ALLOWED` (social/stall.ts), which contains `moveTo`, so a stall owner cannot move;
  - mounts: `MOUNTED_REFUSED = ['sit', 'emote', 'stallCreate', 'alchemyReinforce', 'berserk']` (mounts.ts);
  - alchemy: `FUSE_CANCELLERS = ['moveTo', 'attack', 'useSkill', 'npcTalk', 'pickup']` (alchemy.ts).

  A request type that is not on a module's allow list is refused by that module automatically.
- **Gate order has side effects** [confirmed: modules.ts `askGates`, alchemy.ts `gate`]. Gates run in registration
  order, and the first Fail wins. The alchemy gate cancels a fuse for a `FUSE_CANCELLERS` type **before** later gates,
  or the module itself, might refuse that request. That already happens with `attack` today, and a refused jump can
  still cancel a fuse. That is accepted (§12 Q8).
- **Where each check runs (fact-check 2)** [confirmed: `gameplay.ts request` lines 716–721, `this.modules` at
  312–318, `modules.ts askGates`]: `Gameplay.request` refuses `dead` first; then it asks every module's `gate` except
  the one that handles the type, in registration order. Only four modules have a gate, in this order: **mounts →
  alchemy → trade → stalls**. Only then does it call the handling module's `request`. So the jump module's own
  checks (`cant_act`, `busy`, `cooldown`) always run **after** the lock gates, and the alchemy gate cancels a fuse
  before `cant_act`/`busy`/`cooldown` can refuse the jump. The module's place in `this.modules` does not change this,
  because `askGates` skips the module that owns the request.
- **Crowd control.** Stun, freeze and knockdown have `STATUS_RULES.blocks`, and `Skills.held(p, now)` reports them
  [confirmed: skills/engine.ts line 511]. The jump checks `held` explicitly.
- **Posture.** `posture.ts standUp(p)` is public [confirmed: line 95].

### 4.2 The jump: server rules

| Rule | Value |
|---|---|
| What it does | Plays JUMP (standing) or JUMP_RUN (moving) for everyone who sees the player. **The server position never changes.** The height is only the clip's Bip01 motion; the entity root stays on the ground. |
| Crossing terrain | **Never.** A jump neither starts, changes nor ends a move. A moving player keeps its current `move`, and JUMP_RUN plays over it. So it **cannot cross a blocked nav edge, a wall, the coast bounds line or a closed cell, by construction**. No `nav` call is made. |
| Check order **(fact-check 2: re-ordered to match the dispatcher, §4.1)** | In `Gameplay.request`: (1) `dead`; (2) the module gates in registration order: `mounted` (mounts), then the alchemy gate cancels a running fuse (and never refuses a jump), then `stalling` (the stall owner; trade no longer refuses, §4.3). Then in `movement.ts request`: (3) `cant_act` when `skills.held(p, now)` (stun, freeze, knockdown); (4) `busy` while a skill cast or its post-release action runs, or a return-scroll cast runs: the exact test `emote` uses, `g.itemUses.skillBusy(p, now) \|\| g.itemUses.casting(p)` [confirmed: posture.ts line 87]. Unlike `emote`, moving is **not** `busy`; (5) `cooldown` when `now < p.cooldowns.get('move.jump') − JUMP_COOLDOWN_SLACK_MS` (`p.cooldowns: Map<string, number>` [confirmed: world.ts line 106]; today it holds only item and mount-item groups [confirmed: `item-use.ts`, `mounts.ts`], so a `move.` key collides with nothing). A stunned mounted player therefore gets `mounted`, not `cant_act`. |
| Sitting | A sitter stands up first (`g.posture.standUp(p)`), then jumps. Same as `emote`. |
| Cooldown | `JUMP_COOLDOWN_MS = 1000`, kept in `p.cooldowns` under `move.jump` (the existing per-player cooldown map), spent on acceptance. The clip is 1.10 s (JUMP) or 1.00 s (JUMP_RUN), so a second jump can start during the landing absorb. **(P-JUMP 2026-10-01)** Now 1.37 s (JUMP), 1.13–1.17 s (JUMP_RUN) and 1.30 s (JUMP_RUN_FIST), landing at 833–900 ms: the 1000 ms cooldown is kept, and a second jump still starts during the landing absorb, never in the air. It blends in from that pose (0.25), which is accepted. **(fact-check 2) Jitter slack:** the client gate (§6.3) times 1000 ms from its own key presses, and the server times 1000 ms from arrivals. A player holding the rhythm (tapping as fast as the gate allows) sends each press exactly 1000 ms after the last, so any arrival jitter (the second packet a few ms faster than the first) is refused `cooldown` about half the time, while the jumper's own client has already played it (prediction) and the viewers see nothing. The server therefore accepts from `readyAt − JUMP_COOLDOWN_SLACK_MS` (150 ms). The rate limit (2/s, burst 3) still caps abuse. |
| Rate limit | `jump {perSecond: 2, burst: 3}` in `CLIENT_RATE_LIMITS`. An over-budget request is refused `rate_limited`, never a strike [confirmed: connection.ts]. |
| Key repeat | A held Space never repeats: KeyMap drops `ev.repeat` unless a binding sets `repeat` [confirmed: hud/keys.ts]. |
| Broadcast | `jump {id, at}` to viewers including the jumper (`broadcastAbout`, the `emote` precedent). There is no state in `EntityState`, since a jump lasts at most 1.1 s (1.37 s since P-JUMP). A late joiner never sees a jump that is in progress, which is accepted. |
| Combat | No effect on hits, aggro, range checks or anything else. Mobs ignore it. The jump neither cancels nor delays auto-attack (§6.2 covers the look). |
| Not refused | While moving (JUMP_RUN), in combat, visiting a stall (the visit ends only by the 500 ms distance check, and a jump moves nothing), in town, **and while trading (fact-check 2, §4.3)**. |
| GM | No new command. `/speed` does not change the clip's timing. |
| Future (not this wave) | A real vertical jump over low fences needs nav-edge classes (flag-1 edges under ~0.8 m) and a server walk that treats them as passable while airborne. That is a separate spec (§12 Q6). |

### 4.3 Lock rules (wave 8) in one table

| State | jump | How [confirmed: the gate lists in §4.1] |
|---|---|---|
| Mounted on a horse | `mounted` | Add `'jump'` to `MOUNTED_REFUSED` (mounts.ts) |
| Stall owner | `stalling` | Automatic: not in `STALL_ALLOWED` (which has no `emote` either; the owner sits in the VENDOR pose) |
| Visiting a stall | allowed | No change |
| Trading | **allowed (fact-check 2)**; the trade is **not** ended | Add `'jump'` to `TRADE_ALLOWED` (social/trade.ts), next to `emote`. The draft refused it automatically (`trading`). That contradicted both the user's "jump anywhere" and the I8 precedent that lets a harmless `emote` through a trade [confirmed: trade.ts]. It is not a `TRADE_BREAKERS` entry, so the trade stays open |
| Alchemy fuse running | cancels the fuse | Add `'jump'` to `FUSE_CANCELLERS` (alchemy.ts). The cancel happens even when a later check refuses the jump: `stalling`, `cant_act`, `busy` or `cooldown` (gate order, §4.1). A mounted player keeps the fuse, because the mounts gate refuses first |
| Sitting | stands up, then jumps | Movement calls the public `g.posture.standUp(p)`; no posture.ts edit |
| Dead / held | `dead` / `cant_act` | movement.ts |
| Skill cast / return scroll cast | `busy` | movement.ts |
| In combat, moving | allowed | — |

### 4.4 Balance

- **No gameplay value, by design.** The jump changes no position, no hit and no range. It cannot dodge, kite, skip a
  cast or pass a wall. So there is nothing to balance and no PvP concern (PvP is out of scope anyway: PROTOCOL §3)
  [confirmed by construction].
- **Spam** is capped three ways: the 1 s cooldown, the rate limit, and the client's own cooldown gate (§6.3). Five
  friends spamming Space cost each viewer at most 5 × 41 B/s of network [projected].

---

## 5. Protocol additions (additive, protocol v1) **(jump only 2026-09-29)**

`packages/shared/src/movement.ts` (new, pure):

```ts
export const JUMP_COOLDOWN_MS = 1000
/** A viewer that receives `jump` later than this after `at` plays nothing. */
export const JUMP_LATE_DROP_MS = 600
/** The jumper's client ignores its own echo if it predicted a jump this recently. */
export const JUMP_ECHO_WINDOW_MS = 600
/** The furthest a late viewer seeks into the clip: the take-off. It may skip the crouch, never the air. */
export const JUMP_MAX_SEEK_MS = 200
/** (fact-check 2) The server accepts a jump this long before its cooldown ends (arrival jitter, §4.2). */
export const JUMP_COOLDOWN_SLACK_MS = 150
```

`protocol.ts`:

```ts
// ClientMessage (a GameplayRequest: exactly one actionResult)
| { t: 'jump' }
// ServerMessage
| { t: 'jump'; id: number; at: number }          // server ms; viewers (the jumper too) play JUMP / JUMP_RUN
// GameplayRequest / GAMEPLAY_REQUESTS: + 'jump'
// CLIENT_RATE_LIMITS: jump { perSecond: 2, burst: 3 }
```

- **Validators (`validate.ts`).** The client `jump` has no fields; the server `jump` needs an integer `id` and a finite
  `at`.
- **Older clients** drop an unknown server `jump` frame with a `console.warn` in `net/wire.ts` [confirmed]. That is
  harmless.
- **Fail reasons** reuse existing `ActionFailReason` values (`dead`, `cant_act`, `busy`, `cooldown`) and the wave-8
  `mounted` and `stalling` [confirmed: `fail('mounted' | 'stalling')` in mounts.ts, stall.ts]. **(fact-check 2)** No
  `trading`: the jump is allowed in a trade (§4.3).
- **Collision check** [confirmed: grep of `protocol.ts` at HEAD `fcbdf92`]:
  - there is no `t: 'jump'` in either union;
  - a client `jump` next to a server `jump` follows the `emote`/`chat` precedent of one name in both directions;
  - the other parts of this wave (the palace-steps character screens, the draw-call pass, the coast, the grass and
    wildlife) add no protocol name that collides [likely: none of them is a gameplay request]. The wave plan re-checks.
- **Removed from the first draft:** `roll {yaw}`, `MoveState.style`, the `validate.ts moveState()` pass-through, and
  the `connection.ts` → `onMoveTo(target)` seam. See the appendix "Deferred: the dodge roll".
- **docs/PROTOCOL.md** gets a "Jump" subsection in §11.

---

## 6. Client (apps/game) **(jump only 2026-09-29)**

### 6.1 Clips and the pack

- **Loading.** `three/models.ts` loads `char/_anims/<skel>/movement.glb` together with the `default` pack, reads
  `movement.json`, and retargets JUMP and JUMP_RUN by joint name (the ASSETS §5.3 path both prototypes proved).
- **Names.** `KEEP_CLIPS` gets `JUMP|JUMP_RUN`.
- **A missing pack** (an old `/out/` tree) means no clips. The key still sends, the server still accepts, and nothing
  plays. That fallback is tested.
- **When it loads (fact-check 2).** Not awaited in the actor build path, and only by the world screen: the pack is
  fetched once per skeleton after `worldEnter`, and a jump that arrives earlier plays nothing. The character stages
  (item 4) have no jump, so they need not fetch it. SCREENS §0B assumed the pack "loads with `default` wherever an
  actor is built, so the stage fetches it too" (~35–52 KB per skeleton for nothing on the select screen); the wave
  plan picks one rule, and the default is this one.

### 6.2 Playing and blending

- **Which clip.** Each viewer picks by its own view of the entity when the event arrives: JUMP_RUN when the entity's
  base clip is RUN (its family RUN), and JUMP otherwise (standing, walking, the combat stance).
  - The `jump` event carries no moving flag, because what matters is what that viewer draws.
  - **(fact-check 2)** "JUMP_RUN" means the clip made for the RUN clip the actor is playing: `clipFor('RUN').name` →
    the index's `runJumps` (§2.2). An armed male's RUN is a 0.666 s weapon cycle, not the fist RUN (§1.1).
- **`playAction` replaces the base; it does not layer over it** [confirmed: models.ts `playAction` stops
  `this.current`, and the base restarts from the action's end observer]. That is why JUMP_RUN is a full-body clip
  that carries its own running legs.
- **Blending:**
  - the first pose snaps (the D25 rule, only for an actor that has never been posed);
  - blend-in is `blendingSpeed 0.25` (4 evaluations), because the crouch starts at once;
  - the blend back to the base is 0.12 (≈ 8 evaluations). The base group restarts with **its own** `blendingSpeed`
    (0.08 from `prepareGroup`), so `playMove` sets the base group's speed to 0.12 for that restart and restores it
    after;
  - when the clip ends, the base that resumes is whatever `currentBase` is by then: STAND1, the combat stance
    ATTREADY, or RUN/WALK when moving.
  - W9F CPU-2 already forces every-frame updates while a clip blends, so a far actor blends as fast as a near one
    [confirmed: models.ts `lodTick` → `blending()`].
- **JUMP_RUN and the run phase.**
  - The prototype JUMP_RUN ends exactly on the **fist** RUN's phase 0, and the base restarts from 0 [confirmed:
    `jump_run_filmstrip.png`, last frames], so for an unarmed male the exit is seamless.
  - **(fact-check 2) For everyone else it is not.** An armed male's base is a 0.666 s weapon RUN that starts at
    **left** mid-stance; restarted at 0 after the fist JUMP_RUN (which ends right foot planted, left leg up behind),
    its legs swap during the 0.12 blend [confirmed: §1.1 table]. The fix is the per-cycle clip of §3.3, which ends on
    a phase of the actor's own RUN, and a base resume at that phase (`exitPhaseS`).
  - The entry is not seamless either: a press lands at any RUN phase. **Default:** when the running base is within the
    first 0.15 s of **its own cycle's right stance** (fist RUN: 0–0.15 s; weapon and female RUNs: about 0.30–0.40 s,
    from the index's `enterPhaseS`), JUMP_RUN starts seeked by that offset, because its first 0.2 s are RUN plus small
    deltas. Otherwise it starts at 0 with the 0.25 blend. The legs then swap within ~67 ms at 60 fps (4 evaluations;
    ~28 ms at 144 fps), which is visible only frame by frame [likely; §9 check 2]. On the 0.666 s cycles the right
    stance is only ~0.1 s, so about 15 % of presses seek and the rest blend (fist RUN: about 19 %) [projected].
  - **(fact-check 2) One seek budget.** The phase seek and the viewer's latency seek add up; their sum is capped at
    `JUMP_MAX_SEEK_MS` (200 ms, the take-off). When the sum would pass it, the viewer drops the phase seek and starts
    at the latency seek with the 0.25 blend. Otherwise a late viewer could start after the take-off and skip into the
    air.
  - A mirrored left-foot variant (JUMP_RUN_L, entering at the left contact) removes that blend. It is not in v1 (§10
    cut 1).
- **A stop during JUMP_RUN.** If a `stop` arrives after the clip's `land` event, the clip is cancelled to the base
  (STAND1) at 0.12. That avoids up to 0.4 s of running in place. Before the land event, the air part plays out first.
- **A move during JUMP** (a click while standing jumping). ~~The entity slides at run speed under the standing clip
  until it ends, which is up to 1.1 s. Default: accepted.~~ **(fact-check 2)** That is up to 6 m of gliding in a
  crouch, landing or rebound pose at 5.5 m/s, the very look §10 cut 6 calls "broken". Pressing Space and then clicking
  away is the most common way a jump ends, so it matters. **New default:** a move that starts during a standing JUMP
  cancels it to RUN (0.12 blend) when the clip is before its `takeoff` event or after its `land` event. Only the air
  part (≤ 433 ms, ≤ 2.4 m; **≤ 700 ms, ≤ 3.9 m since P-JUMP**, read from the index) plays over the slide, where it reads as a forward leap. The clip is never swapped for
  JUMP_RUN mid-air (§12 Q3).
- **Moving jump: JUMP_RUN needs no exemption; the standing JUMP gets a timed one (fact-check 2).**
  - `entities.ts update` calls `actor.cancelAction(cancelledByMove)` whenever the entity moves [confirmed].
  - But `cancelAction` stops the action only when the predicate matches its name. `MOVE_CANCELS` is
    `/^(SIT_DOWN|STAND_UP|EMOTION\d+|PICK|STAND[234]|TURN_[LR])(_|$)/`, which does not match JUMP or JUMP_RUN
    [confirmed: models.ts `cancelAction`, entities.ts].
  - While an action plays, `play(RUN)` only records `currentBase` [confirmed].
  - The rule above adds one small `entities.ts` change: the predicate also returns true for the name `JUMP` (never
    `JUMP_RUN*`) while `movement.jumpGrounded(view)` says the clip is before take-off or after landing (from the
    index events and the clip cursor).
  - MV-C adds tests that pin both: "a moving entity keeps JUMP_RUN" and "a move cancels a grounded standing JUMP, not
    an airborne one".
- **A jump during auto-attack.** The next ATTACK clip replaces JUMP, because both are actions. That is accepted, and
  the hunt checks that it never leaves a T-pose.
- **Weapon stances.** The generic clips hold the fist-stance arms.
  - **Every armed player has a weapon family.** `StarterWeapon` is sword/blade/spear/glaive/bow, with no fist family
    [confirmed: protocol.ts]. **(fact-check 2)** A player with no weapon equipped has none (`entities.ts
    weaponFamily()` returns undefined) and plays the `default` (fist) clips. And the families do **not** all have
    their own stand: `FAMILY_CLIP` picks a family variant only where the pack has one [confirmed: `models.ts clipFor`,
    sidecar groups]:
    - sword/blade: only `RUN_*_runforward_sword`. Standing and the combat stance are the default STAND1/ATTREADY;
    - bow: `RUN_bow_run_fighter` and `ATTREADY_bow_stand`; STAND1 is the default;
    - spear/glaive: STAND1, WALK, ATTREADY, RUN and STAND3 of their own.
  - JUMP and JUMP_RUN get a **masked arm layer**. It is a clone of the weapon family's base clip, restricted to the arm
    and weapon-hand joints (clavicle → hand and fingers).
    - For JUMP_RUN the base clip is the family RUN, started at the same phase as the JUMP_RUN's own base cycle
      (§3.3), so the arms swing in step with the legs. For a standing JUMP it is the family stand or ATTREADY; a
      running arm swing on a standing jump would look wrong (fact-check).
    - **(fact-check 2)** For a standing sword/blade JUMP (and a standing bow JUMP out of the combat stance) the
      family's "stand" **is** the default STAND1 that JUMP was keyed from, so the layer would only freeze the arms at
      idle and hide the polish. Default: no standing layer for sword/blade, nor for bow outside the combat stance. It
      costs nothing and keeps the polished arms for the most common class.
    - The layer is played after the jump, so it wins on those joints. That is the existing overlay rule (models.ts
      "Partial (overlay) clips").
    - On the male skeleton it is 23 joints and 46 channels [confirmed: `factcheck/count.py`].
  - The layer covers:
    - sword/blade: the right arm (sword), plus the left arm when a shield is worn;
    - spear/glaive and bow: both arms.
  - Trade-off [likely]: the layer hides the polished arm swing on the weapon arm(s). For a sword user the free left arm
    keeps the polish. §9 check 2 shows both, and §10 cut 2 removes the layer.
- **The nameplate** stays at the root height and does not bob (§12 Q5). The camera follows the root, so it does not
  bob either.
- **Viewers and latency.** A viewer that receives `jump` more than `JUMP_LATE_DROP_MS` (600 ms) after `at` plays
  nothing. Otherwise it seeks the clip by `min(serverNow − at, JUMP_MAX_SEEK_MS)` (the client has `serverNow()` in
  `WorldFeatureContext` [confirmed: features.ts]): a late viewer may skip part of the crouch, but it always shows the
  air. **(fact-check 2)** The JUMP_RUN phase seek shares that 200 ms (see "One seek budget" above).

### 6.3 Input and feel

- **Key: Space = jump** (the `KeyMap`, group `movement`, `keys: [' ']`). It is not rebindable in v1, because there is no
  rebinding UI.
  - [confirmed free: every `keys: [...]` registration in apps/game was listed at HEAD `fcbdf92` (c, f, f8, f9, g, h,
    home, i, m, n, p, q/l, s/k, tab, u, z, the hotbar keys); `normalizeKey` lower-cases, so Space stays `' '`; the raw
    `keydown` listener in screens/world.ts handles Enter and Escape only].
- **Prediction.** The own character starts the clip at once on the key press, so there is no round trip in the feel.
  - The server's echo is ignored when it answers a predicted jump; otherwise the clip would restart. (H-10R MV-1: the
    client matches each own echo to its request, oldest first, instead of the `JUMP_ECHO_WINDOW_MS` timer, so a slow
    round trip no longer replays the jump; a refusal removes its request, and a request without an answer expires
    after `JUMP_COOLDOWN_MS + 2 × JUMP_LATE_DROP_MS` = 2.2 s.)
  - On a refusal (`actionResult ok: false`) the predicted clip just finishes; it is cosmetic.
  - **(fact-check 2) No prediction when the client already knows it would look wrong.** The client still sends, but
    waits for the echo, when its own character is:
    - **sitting.** The server answers, then broadcasts `entityUpdate {posture: 'stand'}`, then `jump` [confirmed:
      `posture.ts standUp`, the emote precedent]. The client turns the posture change into `setIdle('stand', 'play')`
      → `playClip('STAND_UP')` [confirmed: `world/features/posture.ts`, `entities.ts setIdle`], and `playAction`
      replaces whatever action plays. So a predicted JUMP would be cut by STAND_UP, and the echo, arriving inside the
      echo window, would be ignored: the jumper would see no jump at all. Without prediction the jumper sees STAND_UP
      replaced at once by the echoed JUMP, like every viewer;
    - **playing a skill or cast action, or reading a return scroll.** `playAction` would stop the skill clip on the
      caster's own screen, and the server then refuses `busy`;
    - **mounted, a stall owner, dead, or held** (stunned, frozen, knocked down). The server refuses these, and a
      predicted JUMP would show a rider leaping out of the saddle, or a stunned body hopping.
  - The client knows each of these states (its own idle reasons, `actor.isSkillPlaying`, the mount and stall views,
    the status icons). A state it gets wrong only costs one unpredicted jump.
- **Client cooldown gate.** The client keeps its own `move.jump` ready time and does not send while it runs. A spammed
  Space is dropped silently, with no toast. It is dropped client-side instead of refused, so there is no refusal to
  show.
- **Toasts** show the fail text only for `mounted` and `stalling` (i18n `en-movement.ts`; **(fact-check 2)** no
  `trading`, §4.3). `dead`, `cant_act`, `busy` and `cooldown` are silent.
- **Space on a focused HUD button** [unknown]:
  - KeyMap skips typing targets (INPUT, TEXTAREA, SELECT, contentEditable) but not a focused `<button>` [confirmed:
    hud/keys.ts `isTypingTarget`].
  - KeyMap calls `preventDefault()` on the keydown [confirmed: hud/keys.ts line 127]. Whether that stops the browser's
    Space-activates-button on keyup in every browser the friends use (Chrome, Safari, Firefox) is [unknown].
  - Default: MV-C blurs a focused non-typing element when Space is pressed in the world, and a test pins "Space jumps
    and does not click the last clicked button".
- **Removed from the first draft:** the V key, the click buffer, and the self root easing (roll only).

### 6.4 HUD and audio

- **HUD.** There is no cooldown ring: 1 s is too short to need one. The key help lists Space.
- **Audio.** The take-off and landing events (§2.2) become synthetic `ClipTrack`s in `audio/entity.ts`/`cues.ts`,
  which play the footstep file of the surface (`audio/surface.ts` gives the surface).
  - A distinct "land" cue in the retail bank is [unknown]. Default: the footstep file played twice, 30 ms apart, at
    +2 dB.
  - A landing in shallow water (the coast's beach, item 2 of this wave) ~~plays the water footstep if
    `audio/surface.ts` reports water there [likely]~~. **(fact-check 2)** `SurfaceProbe.surfaceAt` reads only the
    terrain tile's `tile2d` type (or the object floor); it knows nothing about water planes [confirmed:
    `audio/surface.ts`]. The coast's shallow sea lies over **sand** tiles (its palette retypes them `Sand`, COAST
    §7.1), and walking on the bed is the retail rule (COAST: "water is neither a walking surface nor a blocker"). So a
    landing in 1–2 m of sea plays the sand step. A water sound needs a water-height check: `waterLevelAt(x, z) −
    groundY > 0.1 m` → `Water`, from the coast lane's sea level (+5 m) and the retail water planes. That is a seam with
    COAST and the footstep runtime, not a jump-only change; default: MV-C calls it if the coast lane exports it, else
    sand.

---

## 7. Budgets per preset (WAVE_PLAN3 §5.2 format) **(jump only 2026-09-29)**

Dev PC = Ryzen 5 9600X + RX 9060 XT. Nothing here touches the GPU: no new materials, shaders, draws, render targets or
defines, so no recompile [confirmed by design: the change is animation groups and network messages only]. That
matters in this wave, whose item 1 is cutting the plaza from ~700 draws to well under 100: **the jump adds 0 draws.**

**How the CPU is measured.** `work/tmp/movement/factcheck/bench-anim.ts` runs Babylon 9.28 `NullEngine` (CPU only, no
GPU lock needed) on the dev PC:

- 20 instances of the converter's male adventurer, all at full rate;
- `scene.animate()` + `Skeleton.prepare()` per simulated 16.7 ms frame;
- the JUMP clip retargeted by name, played with the game's `playAction` semantics (the base stops, blend-in 0.25, the
  base resumes at 0.12);
- every actor jumping every 1.3 s, 3 rounds of 390 frames each.

Results:

- **First prototype JUMP** (the budget reference, a quiet machine), mean / p95 per frame [confirmed]:
  - idle STAND1: 0.44 / 0.57 ms, so **0.022 ms per full-rate actor**;
  - all 20 jumping: 0.65 / 1.04 ms, a delta of **+0.20 / +0.47 ms**;
  - all 20 jumping with the 46-channel arm layer: 0.88 / 1.27 ms, a delta of **+0.44 / +0.70 ms**.
- **Polished clips, re-run on 2026-09-29 evening** (`polish/bench-anim2.ts`, the same bench pointed at the new pack)
  [confirmed]:
  - JUMP (47 channels) and JUMP_RUN (48 channels) have the same channel count as the prototype;
  - the machine was loaded by the release workflow, so rounds varied ±0.3 ms. Idle alone measured 0.38–0.71 ms mean
    across rounds, and the old prototype re-run gave the same spread;
  - the polished clips were within that noise of the prototype. The budget keeps the quiet-machine numbers above.
- **(fact-check 2) Re-run, 2026-09-29 22:00, still a loaded machine** (`polish/bench-anim2.ts 20 chinaman_jump` and
  `… chinaman_jump_run`; output in `factcheck2/bench_jump*.txt`) [confirmed]:
  - JUMP: idle 0.42–0.47 ms mean, all 20 jumping 0.35–0.39 ms mean (the jump replaces STAND1, so it is not dearer);
    with the arm layer 0.62–0.76 ms mean, p95 0.85–1.71 ms (GC spikes in 2 of 3 rounds);
  - JUMP_RUN: idle 0.55–0.72, jumping 0.44–0.52, with the arm layer 0.60–0.81 ms mean, p95 up to 1.55 ms.
  - So the plain clips hold the budget even under load, and the arm layer's p95 is the number to watch: its
    quiet-machine re-run is MV-C's first gate, as the lane table says.
- In game, a far actor on a 10–30 Hz LOD rate runs at full rate during the ~12 blend evaluations of a jump (4 in + 8
  out). Its extra cost there is ≤ the full-rate cost above [projected].
- "Mid" CPU = the WAVE_PLAN3 §5.2 factor ×1.5, also used for Apple M1-class Macs [projected].

| Preset | CPU per jumping actor, dev | 20 actors jumping every 1.3 s, dev, mean / p95 | Same, mid CPU [projected] | GPU | Draws | Download (per skeleton, once) | Network |
|---|---|---|---|---|---|---|---|
| Low (Classic; no animation LOD, every pose every frame) | +0.010 ms mean, ≤ +0.035 ms p95 with the arm layer [confirmed: bench] | +0.20 / +0.47 ms; +0.44 / +0.70 ms with arm layers [confirmed: bench] | ≤ +0.7 / +1.05 ms | 0 | 0 | 78.4 KB raw, **34.6 KB brotli** for JUMP + JUMP_RUN [confirmed: male pack, `br2.ts`, re-run by fact-check 2]; ≤ ~32 KB after meshopt + br [projected]; female 37.6 KB br [confirmed]. **(fact-check 2)** Male with 3 clips (JUMP, weapon JUMP_RUN, fist JUMP_RUN): ~52 KB br [projected] | `jump`: ~41 B to each viewer per jump [projected] |
| Medium (LOD on; the default) | same, plus far actors run at full rate during the ~12 blend evaluations | same or less (LOD'd actors cost less the rest of the time) | same | 0 | 0 | same | same |
| High | same | same | same | 0 | 0 | same | same |
| Ultra | same | same | same | 0 | 0 | same | same |

What this means:

- **The 60 fps goal is not at risk from this feature.** 20 players jumping non-stop cost ≤ +0.70 ms p95 on the dev PC
  [confirmed: bench]. Realistic play (a few jumps a minute each) costs a small fraction of that.
- **WebGPU High is already over budget in crowds** (work/tmp/w9-finish/budgets.md: 21.5 ms p95) [confirmed], and
  Medium must hold 60 fps everywhere (the user, 2026-09-29). So MV-C must not add **per-frame** cost when nobody jumps:
  - no new `onBeforeRender` observers;
  - the masked arm layer is cloned once per actor and family on first use, not per jump;
  - it is stopped, not disposed, between jumps.
- **The arm layer is about half the cost**: +0.24 of the +0.44 ms mean, and +0.23 of the +0.70 ms p95. That is one
  more reason it sits high in the cut order (cut 2). **(fact-check 2)** Skipping it on standing sword/blade jumps
  (§6.2) removes it from the most common standing case at no look cost.
- **(fact-check 2) WebGPU and WebGL2, Medium and High.** The jump's cost is pose evaluation on the CPU before the
  frame (`scene.animate`, `Skeleton.prepare`), which is the same on both APIs; it adds no draw, no material, no
  bind and no render target, so the API's per-draw cost does not multiply it. What differs is the headroom, from the
  wave-9 gate (`work/tmp/w9-finish/budgets.md`, p95 frame ms, dev PC) [confirmed: that file]; the "+0.8" column is
  the MV-C worst-case budget (20 players jumping non-stop), "+0.2" a realistic 5 friends:

  | API | Preset | Plaza p95 | Crowd p95 | Crowd + 0.8 | Crowd + 0.2 | Verdict |
  |---|---|---|---|---|---|---|
  | WebGL2 (every player today) | Medium | 12.0 | 11.3 (13.4 with 40 mobs) | 12.1 | 11.5 | passes |
  | WebGL2 | High (plaza before cut 4, crowd after) | 16.7 | 16.0 | **16.8** | 16.2 | the synthetic worst case crosses 16.7 ms; 5 friends do not |
  | WebGPU | Medium | 11.4 | 14.4 | 15.2 | 14.6 | passes |
  | WebGPU | High (cut 4) | 17.9 | 21.5 | 22.3 | 21.7 | already failing without the jump; item 1 (draw calls) must recover it, and its margin must include this +0.2–0.8 |

  On a mid CPU (×1.5 [projected]) Medium WebGPU crowd is already ~21.6 ms before the jump; that is the draw-call
  problem item 1 owns, and the jump adds at most +1.05 ms to it.
- **(fact-check 2) Item 1's likely tools stay compatible.** If the draw-call pass adopts WebGPU snapshot rendering or
  render bundles (budgets.md lists both), a new animation group changes only bone matrices that are already uploaded
  every frame for a visible skinned actor, not the recorded draw list [likely: no mesh, material or visibility change
  is involved]. I-MV checks the jump once with whatever item 1 ships.
- **Server:** one Map lookup for the cooldown and one broadcast. There is no `nav` call. The load is negligible at 20
  players [likely].

**Per-lane budgets** (dev PC, 1080p, the plaza, the minimum of 5 runs).

- A whole-frame in-browser A/B draws on the GPU, so it **takes the GPU lock** (`work/tools/gpu.lock`) like every other
  frame-time measurement, even though this feature adds no GPU work.
- The NullEngine bench needs no lock, but it is run on a quiet machine: nothing else building or benchmarking.

| Lane | Budget |
|---|---|
| MV-C | 0 ms CPU delta at rest (A/B with the feature flag off) and 0 new draws. ≤ +0.8 ms CPU p95 with 20 bots jumping every 1.3 s: the bench's +0.70 ms plus in-game headroom. The lane's first gate re-runs `bench-anim.ts` on the real clips on a quiet machine. Clip load ≤ 30 ms main thread, once per skeleton [projected] |
| MV-P | A jump costs ≤ 0.05 ms server CPU [projected: a Map lookup and a broadcast] |
| MV-A | Each clip ≤ 60 KB raw in the pack [confirmed: 39 KB per clip today]; the round-trip control ≤ 0.1° / 1e-5 m; planted contacts ≤ 1 mm and planted slide ≤ 10 mm per frame (the `moves_keys.json` metrics); **(fact-check 2)** each JUMP_RUN ends within 1 cm (feet) of its own base RUN at `exitPhaseS` and starts within 1 cm of it at `enterPhaseS` |

---

## 8. Lanes **(jump only 2026-09-29)**

This spec is item 3 of the user's redefined wave (2026-09-29). The wave's other parts are:

- item 1: the draw-call pass (instancing and merging trees, town buildings and grass);
- item 2: the coast, with Blender sculpting;
- item 4: character select and create on the Jangan palace steps (docs/SCREENS.md);
- item 5: the lush painterly grass and the wildlife (butterflies, birds, fireflies and dragonflies, flowers).

The new 3D trees, the sky upgrade, the intro, pets/friends/mail and the dodge roll are deferred. The wave plan that
merges these parts orders the shared files below.

### 8.1 Lane table

| Lane | Owns (new files unless marked) | Edits (additive, listed so the wave plan can seam them) | Depends on |
|---|---|---|---|
| **MV-P** protocol, shared, server | `packages/shared/src/movement.ts` (§5 constants); `apps/server/src/movement.ts` (a `GameplayModule`: `handles ['jump']`; `request` runs the §4.2 checks, stands a sitter up, spends the cooldown, broadcasts `jump`; `forget` clears the cooldown key) | `protocol.ts`, `validate.ts`, `index.ts` (§5); `gameplay.ts` (register the module); `mounts.ts` (`MOUNTED_REFUSED` += jump); `alchemy.ts` (`FUSE_CANCELLERS` += jump); **`social/trade.ts` (`TRADE_ALLOWED` += jump, fact-check 2)**; `apps/game/src/net/mock.ts` + `net/mock/*` (the mock server answers `jump`); `docs/PROTOCOL.md` §11 | none (first) |
| **MV-A** animation pipeline and clips | `packages/convert/tools/blender/moves/key_moves.py`, `extract_deltas.py`, `run_contacts.py` (ported from `polish/`; next to COAST's `tools/blender/*.py`); `packages/convert/src/tools/export-moves.ts` (re-expression and pack writer on gltf-transform, reusing `optimize/anim.ts` naming); `content/moves/europeman_skel/{jump,jump_run,jump_run_fist}.json` and `content/moves/europewoman_skel/{jump,jump_run}.json` (**fact-check 2**: one JUMP_RUN per RUN leg cycle, §3.3; the index carries `runJumps`, `enterPhaseS`, `exitPhaseS` and `air`); `packages/convert/test/moves.test.ts` | `packages/convert/src/cli.ts` (`pnpm sro moves`); `optimize/run.ts` (copy + meshopt the `movement` packs and index); `docs/ASSETS.md` (§5.3: the movement pack and index); the `blenderExe` key in `sro.config.json` (shared with COAST's CST-B, same wave, whoever lands first) | none (parallel with MV-P) |
| **MV-C** client | `apps/game/src/world/features/movement.ts` (the Space key, the intent, prediction, the echo window, the client cooldown gate, the focused-button blur, toasts); `apps/game/src/i18n/en-movement.ts` | `three/models.ts` (movement pack + index load, `KEEP_CLIPS`, `playMove`, the JUMP_RUN phase seek, the base resume at `exitPhaseS`, the stop-after-land cancel, the masked arm layer, blend speeds); `world/entities.ts` (the `jump` event: pick the clip by `runJumps`, the late-drop and one-seek-budget rules; **fact-check 2:** the `cancelledByMove` predicate also cancels a grounded standing `JUMP`, §6.2); `world/intents.ts` (`jump`); `world/features.ts` (register); `hud/keyhelp.ts`; `audio/entity.ts` or `audio/cues.ts` (synthetic tracks from the index events; §2.2); `i18n/index.ts` | MV-P types (a skeleton `movement.ts` + types first); MV-A clips for the look. It runs on the mock with the `polish/` pack until then |
| **MV-L** viewer (optional) | — | `apps/viewer` lists the `movement.json` clips in the animation panel | MV-A |
| **I-MV** integration | — | the merge, docs, the §9 user checks, GIFs of both skeletons with a sword and a spear | all |

**Seams first** (the WAVE_PLAN3 §4 pattern). One agent lands the shared edits before the lanes fork:

- the types in `protocol.ts` and `movement.ts` with the constants;
- an empty `Movement` module registered;
- the empty `playMove` / `movementClip()` hooks in models.ts and the entities.ts `jump` branch, behind
  `hasMovementClips`.

After that MV-P, MV-A and MV-C own disjoint files. The seams with the rest of this wave [likely]:

- `models.ts`: possibly item 1 (actor draw batching) also edits it. MV-C's edits are additive (new functions, one
  `KEEP_CLIPS` entry, and an optional resume frame on the base restart). **(fact-check 2)** Item 4 does **not** edit
  it: SCREENS §6.1 plays `POSE`/`STAND3`/`WALK` through the existing `playClip`/`play` and says so [confirmed:
  SCREENS.md]. The release workflow in flight **is** editing `models.ts` right now [confirmed: `git status`], so MV-C
  starts after that is committed and re-reads the file.
- GRASS_LIFE (item 5): its player push fades above 0.5 m of height over the ground, which needs `jumpLift(view, now)`
  from MV-C (§2.2), since the entity position never rises. Its birds treat a jump like walking (no change).
- COAST (item 2): the optional `waterLevelAt(x, z)` for the landing sound (§6.4).
- `entities.ts`, `features.ts`, `mock.ts`, `protocol.ts`: edited by other parts; the wave plan orders those merges.
- `packages/convert/tools/blender/` and `blenderExe`: shared with the coast lane.
- The draw-call pass (item 1) must keep skinned actors' `playAction`/overlay paths intact. The jump's masked arm layer
  is an ordinary overlay group on the actor, with no mesh or material change, so instancing work on static objects
  does not touch it [likely].

### 8.2 Tests

- **`packages/shared/test/movement.test.ts`:**
  - the constants are positive and consistent (`JUMP_MAX_SEEK_MS` < `JUMP_LATE_DROP_MS`);
  - the validators accept a good client `jump` and server `jump`, and reject a server `jump` with a NaN `at` or a
    non-integer `id`.
- **`apps/server/test/movement.test.ts`:**
  - **a jump never changes `pos` or `move`**: a moving player's `move` object is identical before and after, and no
    `stop` or `move` is broadcast;
  - a jump next to a wall or at the coast bounds line leaves the position unchanged (a jump makes no nav call);
  - a jump broadcasts `jump {id, at}` to viewers and the jumper;
  - a second jump within 850 ms gives `cooldown`; one after 850 ms (1 s minus the 150 ms slack) is accepted;
  - the rate limit gives `rate_limited` and no strike;
  - mounted and stall owner give `mounted` and `stalling`; **(fact-check 2)** a trading player's jump is accepted and
    broadcast, and the trade is **not** ended;
  - **(fact-check 2)** the order: a stunned mounted player gets `mounted`; a stunned player with a fuse loses the fuse
    and gets `cant_act`;
  - a stall visitor may jump, and the visit is unchanged;
  - dead gives `dead`; a stunned, frozen or knocked-down player gives `cant_act`;
  - a skill cast and a return-scroll cast give `busy`, and the cast is not interrupted;
  - a sitter stands up and jumps;
  - a jump cancels an alchemy fuse, even when it is then refused (the gate order).
- **`packages/convert/test/moves.test.ts`:**
  - the re-expression maths on a synthetic 3-joint chain with rotated rest frames (identity round trip);
  - the pack has exactly the skeleton's joint names and rest TRS;
  - the clips have no net XZ root travel (≤ 0.15 m excursion, ≤ 1 cm at both ends);
  - the durations and events match the index;
  - skipped without `work/out`: on the real packs of both skeletons, the control clip is within 0.1°, planted
    contacts are within 1 mm and planted slide is ≤ 10 mm per frame, and JUMP_RUN's lowest contact is ≥ −0.02 m. That
    last check is the one that catches the §3.3 female failure.
  - **(fact-check 2)** every RUN clip of both adventurers (fist and weapon families) maps to a JUMP_RUN in `runJumps`,
    and that JUMP_RUN's first and last frames match its base RUN at `enterPhaseS` / `exitPhaseS` within 1 cm at the
    feet (this catches the fist clip being used on an armed male);
  - `air` has one value per frame, is ≥ −0.02 m everywhere and is 0 ± 1 mm on planted frames.
- **`apps/game/test/movement.test.ts`:**
  - the KeyMap binds Space only when not typing, and never on repeat;
  - the intent is well formed;
  - `entities` does not cancel JUMP_RUN while moving (it pins today's `MOVE_CANCELS` behaviour);
  - **(fact-check 2)** a move cancels a standing JUMP before take-off and after landing, never in the air;
  - JUMP vs JUMP_RUN is picked by the entity's base clip, and the JUMP_RUN variant by `clipFor('RUN')` (a sword man
    gets the weapon-cycle clip, an unarmed man the fist one);
  - after JUMP_RUN the base RUN resumes at `exitPhaseS`, not at 0;
  - the own `jump` echo does not restart a predicted jump;
  - **(fact-check 2)** no prediction while sitting (then STAND_UP followed by the echoed JUMP), during an own skill
    action or return-scroll cast, mounted, as a stall owner, dead or held;
  - the late-drop (> 600 ms) and the seek cap (200 ms), with the phase seek and the latency seek sharing it;
  - `jumpLift` is 0 on planted frames and follows `air` in the air;
  - a `stop` after the land event cancels JUMP_RUN to the base;
  - Space on a focused button jumps and does not click it;
  - a missing movement pack plays nothing and throws nothing;
  - the client cooldown gate sends nothing within 1 s.
- **Gates** (as WAVE_PLAN3 §6.17):
  - every lane runs its tests and `pnpm typecheck`;
  - the Low guard (`packages/world-render/test/seams-classic.test.ts`, plus the release workflow's
    `apps/game/test/release-lowguard.test.ts` and `abuse-w9f-lowguard.test.ts` once committed [confirmed: `git
    status`, `ls`]) stays green, because this feature adds no define;
  - the whole suite at hand-off.
- **Hunt lenses:**
  - jump spam at the rate limit from 5 clients;
  - a jump while mounted, stalling, trading, sitting, stunned, dead;
  - older-client behaviour: an unknown `jump` message is ignored;
  - a leak check: masked arm clones disposed with the actor;
  - a jump during auto-attack: the next ATTACK clip replaces JUMP, which is accepted, but check that it never leaves a
    T-pose;
  - a jump at the moment of death, and at the moment a stun lands;
  - a running jump into an arrival `stop`, and a running jump at every RUN phase (the blend-in);
  - a jump on the character-select stage: none. **(fact-check 2)** [confirmed: `screens/charselect.ts` and
    `charcreate.ts` use their own `window` keydown listeners (Enter, arrows, Escape) and never build the HUD `KeyMap`,
    which only `hud/index.ts` creates];
  - **(fact-check 2)** Space tapped at the cooldown boundary for 30 s on the Tailscale link: every jump the jumper
    sees, a second client sees too (the slack works).

### 8.3 User checks (§9 has the list the user runs)

Each lane ends with an in-game check the user can do in under two minutes, with screenshots or a GIF from I-MV.

---

## 9. User checks **(jump only 2026-09-29)**

1. **Look (MV-A, before any code):**
   - now: `work/tmp/movement/polish/out/jump.gif`, `jump_run.gif`, `jump_filmstrip.png`, `jump_run_filmstrip.png` and
     `jump_before_after.png`;
   - then both clips on male and female, with a sword and with a spear, as GIFs. **(fact-check 2)** The running GIFs
     must use the weapon RUN (the one armed players really run), not the fist RUN of today's `jump_run.gif`;
   - the question: "Good enough, more polish, or try mocap (route B)?" Point out the take-off frames: the arms still
     reach straight forward there for ~0.1 s (§3.2 touch-up 0).
2. **Jump in game (MV-C + MV-P):**
   - press Space standing, while running, and in the combat stance: it blends back into idle, run or stance with no
     T-pose and no pop;
   - press it at different moments of the run: the leg swap at the start should not catch the eye;
   - a friend on a second client sees the same jump;
   - on the horse or at your own stall, the toast says why not; in a trade the jump works and the trade stays open;
   - sit, then press Space: you stand and jump in one go, on your screen and your friend's;
   - press Space and click away at once: no long glide in a crouch;
   - hold Space: exactly one jump. Tap it fast: one jump a second, and no toast.
3. **Never through walls:** jump while running into the city wall, at the coast bounds line and on the gate stairs. You
   stop exactly where a plain run stops.
4. **Feel:** on the real link to the mini PC (Tailscale), the jump starts on the key press with no delay.
5. **Frame rate:** the plaza with the perf overlay while 5 friends spam jumps. The frame time does not move visibly,
   and the draw count does not change.

---

## 10. Scope-cut order (cut from the top) **(jump only 2026-09-29)**

1. The mirrored JUMP_RUN_L (a left-foot take-off). JUMP_RUN always starts on its right-foot phase, blending from
   wherever the run is. (It is not in v1 anyway; listed so nobody adds it late.)
2. The masked weapon-arm layer. Generic arms, and the weapon follows the hand. This affects **every** player, because
   every player has a weapon family (§6.2). It also saves about half the jump's CPU (§7).
3. **(fact-check 2)** The male **fist** JUMP_RUN (`JUMP_RUN_FIST`, today's prototype): an unarmed man then uses the
   weapon-cycle clip with the entry and exit blends. Then, if still needed, the female JUMP_RUN as its own authoring
   pass: the minimum is the male weapon-cycle key file on her contact-phase table (both cycles are 0.666 s and start
   at left mid-stance, §1.1). The standing JUMP is shared anyway. The male **weapon** JUMP_RUN is never cut on its
   own; cut 6 removes all running jumps.
4. The take-off and landing sounds.
5. Client prediction. The clip starts on the server's echo, so it plays RTT late on the jumper's own screen.
6. JUMP_RUN as a whole. Space is ignored while moving (not the standing clip over a 5.5 m/s slide, which looks broken).

**Never cut:**

- the server authority (the jump never moves the entity or touches the move);
- the lock rules (§4.3);
- the validators and the rate limit;
- the cooldown;
- the re-expression step and its control test (without it the clips pose wrongly on every actor);
- the per-frame contact solve (without it the feet float or sink);
- the no-per-frame-cost and zero-new-draws rules;
- the Low guard.

---

## 11. Needs from the user (each with the default Claude builds if there is no answer) **(jump only 2026-09-29)**

1. **The polished look** (`polish/out/jump.gif`, `jump_run.gif`, `jump_before_after.png`). **Default: go.** Before the
   female clips, Claude makes the §3.2 Blender-UI touch-ups: **(fact-check 2)** first the take-off arms, which still
   reach straight forward for ~0.1 s; then the take-off forearm, the fists, the apex gaze, and the JUMP_RUN arms and
   split. Note for the user: `jump_run.gif` shows the unarmed run; the armed running jump is keyed next (§3.3).
2. **Key: Space = jump.** Already the user's choice. **Default: yes**; there is no roll key.
3. **Jump everywhere, town included, with a 1 s cooldown.** Already the user's choice. **Default: yes.**
4. **Mocap downloads (route B)** are **not** needed. **Default: none.** If the look is rejected, Claude asks
   separately with the library, licence and size.
5. **Blender MCP** (watching the keying live) is optional. **Default: headless scripts only.** The UI touch-ups are
   done in a saved `.blend` and written back to JSON by `extract_deltas.py`.

## 12. Open questions (each has a default, so nobody waits) **(jump only 2026-09-29)**

1. **JUMP while walking** (if a walk mode is used): the standing clip plays over the walk slide. **Default: yes.** At
   walking speed that reads as a hop in stride [likely].
2. **The JUMP_RUN entry phase:** seek into it for the first 0.15 s of the right stance **of the actor's own RUN cycle
   (fact-check 2: `enterPhaseS` from the index)**, within the shared 200 ms seek budget, else blend from 0 (§6.2).
   **Default: as described.** Add JUMP_RUN_L only if the §9.2 check finds the swap ugly.
3. **A click during a standing JUMP.** **Default (fact-check 2):** before take-off or after landing it cancels the
   JUMP to RUN; only the airborne part (≤ 433 ms; 700 ms since P-JUMP) plays over the slide (§6.2). The draft accepted up to 1.1 s (6 m)
   of gliding. Swapping to JUMP_RUN mid-air would pop, so that is never done.
4. **Mounted jump (a horse jump):** **Default: not in this wave.** There is no retail clip, and it would need a horse
   skeleton clip.
5. **Nameplate follows the jump height:** **Default: no.** It stays at the root, so there is no label bobbing in
   crowds.
6. **Jump over low fences (real vertical movement):** **Default: never in this wave.** A later spec would classify nav
   edges.
7. **Female `Bone01`/`Bone02` (a hair or cloth chain):** **Default: not keyed.** They keep the idle pose's values. Add
   secondary motion (a 2-frame lag of the spine) only if the check shows them stiff.
8. **Does a cosmetic jump cancel an alchemy fuse?** **Default: yes.** It is an action, like `attack`. The fuse is also
   cancelled when the jump is then refused (gate order, §4.1). **(fact-check 2)** The other precedent is `emote`,
   which is **not** a fuse canceller; leaving `'jump'` off `FUSE_CANCELLERS` would remove the "refused jump cancels
   the fuse" wart at no cost. The default stays yes (it was the author's call); the wave plan may flip it.
9. **The friends' RTT to the mini PC** [unknown]. **Default:** prediction hides it for the jumper. Viewers seek up to
   200 ms and drop jumps more than 600 ms late.
10. **A cooldown toast?** **Default: no.** The client drops a Space press during the cooldown silently.
11. **Landing in the sea at the new beaches** (item 2 of this wave: the bounds line sits in ~2 m of water). **Default
    (fact-check 2):** the surface lookup cannot say "water" there (it reads the sand tile, §6.4), so the landing plays
    the water footstep only if the coast lane exports a `waterLevelAt(x, z)`; otherwise sand. No splash effect in v1.
12. **The dodge roll** is deferred (the user, 2026-09-29). **Default:** its design stays in the appendix below, and it
    comes back as its own revision when the user asks.
13. **(fact-check 2) Jump during a trade.** **Default: allowed** (`TRADE_ALLOWED` += jump, like `emote`), per the
    user's "jump anywhere". The alternative is the draft's `trading` refusal.
14. **(fact-check 2) Female spear and bow running jumps.** Their RUN leg tracks are 16–22 cm from her default RUN.
    **Default:** they reuse her one JUMP_RUN with the blends; a clip each only if §9 check 2 shows a pop.

---

## 13. Keyboard movement: W A S D (lane MV-WASD, 2026-10-02)

The user: "Lets also make sure we add the ability to ALSO walk around with WASD keyboard and also be able to click
with mouse." Built in `apps/game/src/world/features/keymove.ts`, composed by `movement.ts` (still the last feature).

**Keys.** W / ↑ forward, S / ↓ back, A / ← left, D / → right, **relative to the camera** (forward is where the camera
looks on the ground, right is the screen's right); two keys walk the diagonal, normalised; W + S cancel out. The
character faces where it walks. Space jumps while walking. Options → Controls → **Keyboard movement** (default on);
off gives today's game (clicks only, and the arrows turn and zoom the camera again). With it on the arrows walk, the
camera turns with the right-drag and zooms with the wheel, and Home still puts it behind you. **S no longer opens the
Skills window: K does** (the menu bar says K). The key help lists the four keys and says how walking works.

**Never while typing or with a modal open**: the KeyMap skips those keydowns, and a walk in progress stops when a text
field takes the focus, a modal opens or the option goes off. Dead: nothing. A stall owner: the features'
`beforeGroundMove` veto ("Close your stall first."), asked once per press. Third person does not swing behind the
character while the keys walk (a strafe would turn into a circle).

**Server authority, no protocol change.** The keys reuse `moveTo`, which the server validates on its navmesh exactly
as a click (decision: the stream is smooth for everyone, measured below, so the additive protocol change was not
needed):

| | |
|---|---|
| target sent | 1 s of walking ahead of the predicted point (≥ 3 m) |
| a turn ≥ 4° (keys, camera drag, a slide) | sent at once; every send takes a token from a bucket of 3 that refills at 10/s (mashed keys or a dragged camera never pass 10/s against the server's 20/s budget) |
| straight on | a keep-alive every 250 ms (also on a timer, so a slow frame does not hold it back): the server's target is always ≥ 0.75 s ahead, so it never stops between two of them |
| release | the stop point (after a run-on of half a round trip + 30 ms, at most 150 ms) as the last target, at once (a release with the bucket empty walks on until it has a token, at most 100 ms) |

Consecutive targets on a line continue the same line, so the other clients (which draw everyone at the server's time)
see one smooth walk; a turn reaches them one latency late (a corner of a few cm). Without the run-on they would see us
walk past the stop point for one latency and snap back; with it the server's last chord reaches the stop point when
they hear of it. The start shows one latency late for them, as every click walk does.

**Client prediction.** The own character walks on the key press; the world screen's own echoes are overridden while
the keys drive. The walk is planned on the client navmesh (a `NavWalker` keeps the surface: plaza deck, bridges): the
straight chord stops at a blocking edge, so the prediction never walks through one. Against a wall it **slides**: the
smallest turn to either side (15° steps up to 60°, bisected to ~2°, then 2.5° further away from the wall) that gives
1 m of free walk; sticky while sliding (no zig-zag). Pushing within 30° of straight into a wall stops. The prediction
may lead the server by the walk of half a round trip + 0.25 s + 0.75 m; further (a gate the client does not know, a
region not loaded) it is pulled back toward the server. After the release it holds the stop point until the server's
stop there (or, after max(0.5 s, 2 round trips + 0.25 s), takes the server's word: a glide of up to 4 m, else a snap).
Mounted, buffed and GM speeds come from the own latest `move`.

**Clicks and keys.** A left click in the world (ground, monster, item, NPC) ends a key walk with no stop of its own
(the click's request drives; the view goes back to the server's walk). A key press ends a click walk: hold to move,
the blocked-path check and an approach (trade, stall) end, and its `moveTo` ends the server's walk or chase as a click
does. An accepted attack, skill, pick-up or NPC talk ends the key walk too (one answering a request sent before the
walk does not). After either, the keys need a new press.

**Tests.** `apps/game/test/keymove.test.ts`: the maths against Babylon's own projection (right- and left-handed),
sliding on a synthetic wall and on the real Jangan fountain rim, the stream against a simulated server with latency
and jitter (no stop between keep-alives, a viewer's copy without jumps, no rubber band, the server stopping where the
client did, within the bucket when mashed, a slow frame neither stalling the walk nor turning the server back),
reconciliation, speed, clicks vs keys, focus, modal, option, death, veto, the KeyMap wiring, Space while walking, the
Skills key. `apps/server/test/keymove.test.ts`: the stream over real
WebSockets (no error, a friend sees one continuous walk, the stop on the release point), the budget still refusing a
flood, and every step clipped at a blocked edge.

---

## Appendix: Deferred: the dodge roll **(jump only 2026-09-29)**

Not in this wave. It is kept here so that a later wave can pick it up without re-deriving the seams. The fact-check
corrections that concern it are items 7–11 and 15–16 of the log below. The user's earlier choices for it: V toward the
cursor, 4 m, 0.85 s in all, 3 s cooldown, no invulnerability frames.

**Clip.** ROLL, one per skeleton, made with the same keyer (§3.2):

- a 100 ms wind-up crouch in place, 600 ms of travel (a tuck, with the arms wrapped), and a 150 ms recovery;
- no XZ root travel: the server move carries the body.

**Server rules:**

| Rule | Value |
|---|---|
| Input | `roll {yaw}`. The client sends the direction toward the cursor's ground point (the facing when the cursor is not on the ground). The **server picks the endpoint**; the client never sends one. |
| Distance, timing | `ROLL_DISTANCE_M = 4`, `ROLL_WINDUP_MS = 100`, travel 600 ms (`ROLL_SPEED = 6.67 m/s`), `ROLL_RECOVER_MS = 150`, `ROLL_MIN_M = 0.5`, `ROLL_COOLDOWN_MS = 3000` (key `move.roll`), rate limit 2/s burst 3. It ignores GM `speedMul`. |
| Validation | From the server's live point: target = pos + 4·(sin yaw, cos yaw), clamped to the bounds, then **`nav.walk`** exactly as a click is walked. It stops at the first blocking edge. A walked length < 0.5 m is refused `unreachable`, with no cooldown spent. |
| Server step order | (1) checks (dead, held, busy, cooldown); (2) a **dry run** `world.nav.walk(live, cx, cz)` (`walkEntity` has side effects even when it refuses: it stands the mover and broadcasts `stop`); (3) `g.onMoveTo(p, now)`, which runs the `moveTo` gates and the `moved` hook, and a `false` refuses `busy`; (4) `world.walkEntity(p, tx, tz, ROLL_SPEED, now, { style: 'roll', startDelayMs: 100 })`; (5) record the roll and spend the cooldown. |
| On the wire | An ordinary `move` with `startedAt = now + 100 ms`, `speed 6.67` and `MoveState.style: 'roll'` (`validate.ts moveState()` must keep the field; today it rebuilds the object from four fields). `livePoint`/`sampleMove` clamp elapsed time at 0, which holds the mover in place during the wind-up. |
| End | At request + 850 ms, checked in `tickPlayer` (10 Hz). It ends early when `p.move` is no longer the roll's move (a stun/freeze/knockdown halt, `stopAction`, a warp, death), and an early end drops the deferred moveTo. |
| While rolling | `moveTo` is deferred, not dropped. That needs a new seam: `connection.ts` passes `msg.x, msg.z` to `Gameplay.onMoveTo(p, now, target)`, which asks `movement.deferMove` before the gates, because a gate never sees coordinates and a gated moveTo is lost. attack/useSkill/pickup/npcTalk/mountRide/sit/jump/roll are refused `busy`. `stopAction` ends the roll. |
| What it ends | Everything a `moveTo` ends (auto-attack, a pickup walk, a cast, a return-scroll cast, sitting, an alchemy fuse), and nothing more. |
| Locks | `mounted` (add `'roll'` to `MOUNTED_REFUSED`), `stalling`, `trading` (refuses, does not end the trade), `dead`, `cant_act`. A stall visit ends through the distance check. |

**Balance:**

- Rolling everywhere is slower than running (4 m per 850 ms against 4.7 m at 5.5 m/s).
- It dodges a mob MSKILL row with `castMs > 0` by leaving reach + 1 m (melee) or + 3 m (ranged) before release.
  7 of 24 low-level Chinese mobs' basic rows have a 1.0–1.3 s cast; the Tiger Girl's ATTACK01 is dodgeable and her
  ranged ATTACK03 is not.
- It dodges no projectile (dropped only 10 m past reach) and no `castMs 0` row.
- Invulnerability frames: none (`ROLL_IFRAME_MS = 0`). The seam is `Movement.evading(p, now)` in mob-skills.ts
  `strike`, which would turn a hit into `miss`.
- It passes through bodies.

**Protocol:**

- `{ t: 'roll'; yaw: number }` (a GameplayRequest; the yaw must be finite and is normalised to (−π, π]);
- `MoveState.style?: 'roll'` (older clients drop it and show a fast slide);
- `rollDir(yaw)` and `rollTarget(x, z, yaw, dist?)` in `shared/movement.ts`.

**Client:**

- the V key;
- a `style: 'roll'` move plays ROLL, seeked on the server clock to `serverNow − (startedAt − 100)`;
- the own predicted ROLL is not restarted by its own move;
- a click buffer during the roll;
- a self root easing that hides the snap-back when rolling out of a run (RTT/2 × 5.5 m: 0.14 m at 50 ms RTT);
- a `move:roll` cooldown ring;
- a cloth whoosh sound.

The wind-up hides the round trip for RTT ≤ 200 ms.

**Lanes it adds back:** MV-P edits `connection.ts`, `world.ts` (`walkEntity` options `style`, `startDelayMs`),
`mob-skills.ts` (the `evading` seam), and the `validate.ts moveState()` pass-through.

**Tests** as in the jump + roll draft:

- a roll into a wall stops at the wall;
- a refused short roll leaves a running move untouched;
- a stun mid-roll drops the deferred move;
- a mob cast is dodged by leaving reach + 1 m.

**Budget:** two `nav.walk` calls per roll, ≤ 0.2 ms server CPU [projected]. It adds no GPU and no draws.

## Appendix: scratch files (`work/tmp/movement/`)

| File | What |
|---|---|
| `list-bans.ts`, `bans.txt`, `bans.json` | §1 inventory of all 536 Chinese `.ban` files: duration, keys, loop flag, root rise/drop/travel, used or not |
| `root-curve.ts` | The Bip01 height/travel curve of any male `.ban` (the leap timing) |
| `blender/key_jump.py`, `blender/make_pack.py` | The first prototype: keying, re-expression, the STAND1 control (§3.1) |
| `viewer/main.ts`, `index.html`, `serve.py`, `sheet.py` | The first prototype's scratch Babylon page, private server on :5197 (stopped), filmstrip/GIF |
| `out/…` | The first prototype's outputs (`jump.blend` and the glbs hold retail skeleton/mesh data: private, never committed) |
| **`polish/keys/jump.json`, `polish/keys/jump_run.json`** | **(jump only 2026-09-29)** The polished key poses: the proposed `content/moves/` format |
| **`polish/key_moves.py`** | The polished keyer: absolute angles, one rotation sense, abduction, toe-roll, per-frame contacts, parabolic air, AUTO Bezier. Args `<char.glb> <out-dir> <prefix>` |
| **`polish/make_pack2.py`** | Multi-clip re-expression and pack writer (imports `blender/make_pack.py`'s maths), the index, the checks |
| **`polish/run_feet.py`, `run_feet_w.py`** | The retail RUN's foot contacts per 1/30 s (male, female) |
| **`polish/viewer/main2.ts`, `serve2.py`, `capture.sh`, `index.html`** | The Babylon capture page (modes `jump`, `run`, `old`), private server on :5198 (stopped), headless Chrome with a scratch profile (closed) |
| **`polish/sheet2.py`** | Filmstrips, GIFs and the before/after sheet |
| **`polish/br2.ts`, `polish/bench-anim2.ts`** | Brotli size of the packs; the §7 bench pointed at the polished pack (`pnpm tsx … 20 chinaman_jump`) |
| **`polish/out/man/`, `polish/out/woman/`** | `moves.blend`, `moves_blender.glb`, `movement.glb`, `movement.json`, `moves_keys.json` (per-frame metrics), `roundtrip.json`. The woman's `chinawoman_jump_run` is the **failed** transfer of §3.3, kept as the test case |
| **`polish/out/*.png`, `*.gif`** | `jump_filmstrip.png`, `jump.gif`, `jump_run_filmstrip.png`, `jump_run.gif`, `jump_before_after.png` |
| `polish/frames/` | The raw captured frames and per-mode `*_report.json` (pelvis and toe height per frame, as Babylon evaluates them) |
| `factcheck/make_pack_check.py` | The fact-check's re-run of `make_pack.py` into `factcheck/out/`. It gave the same pack byte for byte, the same control numbers, and the rest re-orientation histogram (42 × 120°, 1 × 90°) |
| `factcheck/bench-anim.ts` | The NullEngine CPU benchmark of §7 (`pnpm tsx work/tmp/movement/factcheck/bench-anim.ts 20`) |
| `factcheck2/family_run_feet.py`, `family_run_feet.json` | **(fact-check 2)** Toe heights and forward positions per 1/30 s of every RUN variant (fist, sword, spear, bow) on both adventurers, with the planted feet marked (§1.1 table). Run: `cd work/tmp/movement && python factcheck2/family_run_feet.py` |
| `factcheck2/bench_jump.txt`, `bench_jump_run.txt` | **(fact-check 2)** The §7 bench re-run on a loaded machine |
| `factcheck/br.ts`, `skel.py`, `joints.py`, `count.py`, `turn.py`, `mobcast.py` | JUMP pack brotli size; skeleton per sidecar; joint counts; arm-layer channels; TURN/DOWN clip sources; mob swing cast times |

## Appendix: fact-check log (2026-09-29)

Re-derived and **held**:

- **Retail data.**
  - 282 + 254 `.ban` files, 377 used; no jump or roll by name.
  - `a_standroll` is TURN_L/R, with 0.09 m of root travel.
  - The leap curve: −0.33 at 166 ms, apex 1.37 at 466 ms, ~0 at 709 ms.
  - 13 + 13 models on `europeman_skel` / `europewoman_skel`.
  - The adventurer has 225 clips in 9 groups. STAND1 has 14 keys and RUN has 13; RUN has two type-2 events.
  - 43 / 45 joints, with `Bone01` → `Bone02` under `Bip01 Spine1`.
- **Prototype maths.**
  - STAND1 control within 0.031° / 7.8e-7 m.
  - Pack vs export within 1.7e-5 m.
  - The pack is 48,224 B, 47 channels, 39 keys, 1.267 s.
- **Babylon.** The glTF loader's `targetFps` is 60 (`glTFFileLoader`).
- **Game code.**
  - D25 `startUnblended`; the W9F CPU-2 blend rule.
  - `livePoint` / `sampleMove` clamp elapsed time at 0.
  - The trade, stall, mount and alchemy gate lists.
  - `MOB_RELEASE_SLACK_M = 1`; `miss` in `HitOutcome`.
  - Space and V are free.
  - PvP is out of scope (PROTOCOL §3).
  - `default.glb` is 2.43 → 1.09 MB with brotli.
  - High crowd p95 21.5 ms.

**Corrected** (the section says what changed; items marked "roll" now live in the deferred appendix):

1. §1.1: the > 0.3 m rise list also holds `a_down`, the sit-stands and two unused `spidey_*` clips. The "fly" search
   also finds `man_avatar_fly`.
2. §3: the prototype's take-off is at 400 ms against the retail ~200–233 ms. Only the air time matches. (Fixed by the
   polish: 200 ms.)
3. §3: the re-orientation is 42 joints × 120° and 1 × 90°.
4. §2.2: the Blender scripts move to COAST's `packages/convert/tools/blender/`, with the `blenderExe` key. The packs
   live in `out-opt` today.
5. §2.2 / §6.4: footsteps come from `ModelSounds` clip tracks (`audio/entity.ts`), not from sidecar events or
   `audio/surface.ts`.
6. §4.1: `MOVE_SPEED` / `TICK_HZ` are server env keys.
7. (roll) §4.1: `moveTo` is not a GameplayRequest. Its gate gets no coordinates, and a gated moveTo is dropped. **The
   deferred moveTo needs a new `connection.ts` → `onMoveTo(target)` seam.**
8. (roll) §4.1 / §4.3: `walkEntity` stands the mover and broadcasts `stop` even on a refused walk. **The roll needs a
   dry-run `nav.walk`.** It is two walks per roll.
9. (roll) §4.3: a blocking status halts the mover. The roll's end (request + 850 ms, 10 Hz) and its early end are now
   defined; an early end drops the deferred moveTo. `mountRide` and `sit` are added to the busy list.
10. (roll) §4.4: every mob swing is an MSKILL row (`mobSkills.swing`), not `Gameplay.attack`. 7 of 24 low-level Chinese
    mobs' basic rows have a 1.0–1.3 s cast and are dodgeable.
    - The Tiger Girl's ATTACK01 is dodgeable; her ranged ATTACK03 is not.
    - Projectiles are dropped only 10 m past reach.
11. (roll) §4.4: a roll passes **through** bodies (the draft said "never").
12. §4.5: a stall visit ends by the distance check, not `moved`. The gate order cancels a fuse even for a refused
    request.
13. §6.2: `playAction` replaces the base, so JUMP_RUN carries its own legs.
    - The `cancelledByMove` exemption is unnecessary: `MOVE_CANCELS` never matches JUMP. The seam is removed.
    - The blend back uses the base group's speed.
14. §6.2: every player has a weapon family, so the arm layer matters to everyone. Its source is the family stand for
    JUMP and the family RUN for JUMP_RUN. It is 23 joints and 46 channels.
15. (roll, partly jump) §6.2 / §4.2: the own jump echo and own roll `move` must not restart predicted clips. Viewers
    seek ROLL on the server clock.
16. (roll) §6.3: the move beats the displacement for RTT ≤ 200 ms, not ~100. A roll from a run snaps back by RTT/2 ×
    5.5 m (there is no smoothing), so a self easing is added. There is a Space-on-focused-button risk (it also applies
    to the jump; §6.3).
17. §7: the per-actor CPU projection divided an LOD'd, world-object-inclusive number. It is replaced by a measured
    NullEngine bench: +0.47 / +0.70 ms p95 for 20 non-stop jumpers without / with the arm layer.
    - Download is ≤ ~55 KB for three clips (JUMP is 18.0 KB with brotli). With jump only, it is 34.6 KB for two
      clips, measured.
    - Frame A/Bs take the GPU lock.
18. §8: sky + coast (+ trees) were wave 10. **(jump only 2026-09-29)** Superseded by the user's redefined wave: the
    coast is in the same wave as the jump; the sky and trees are deferred.
19. §12 Q10: BACKLOG routed the trees request to wave 10 (docs/TREES.md). **(jump only 2026-09-29)** The new 3D trees
    are now deferred; no effect on this spec.

**Added by the jump-only revision (2026-09-29 evening):**

20. The first prototype's "stiff forward arms" had three causes: little elbow bend and no abduction; per-bone sign
    tests that are ambiguous on forward-pointing bones; and a spine lean that leaked into the legs, because the
    thighs hang from `Bip01 Spine` [confirmed: glb node tree, `blender/key_jump.py`]. The polished keyer fixes all
    three (§3.2).
21. Foot contacts solved only on keys let the feet float or sink between Bezier keys. The polished keyer solves them on
    every frame [confirmed: `moves_keys.json`].
22. The key-pose JSON cannot name RUN phases in seconds across skeletons: the female RUN is 0.667 s and starts at left
    mid-stance [confirmed: `run_feet_w.py`, the failed `chinawoman_jump_run`]. JUMP_RUN is authored per skeleton with
    contact-named phases (§3.3).

**Added by the second fact-check (jump only, 2026-09-29 night; scratch in `work/tmp/movement/factcheck2/`):**

23. §1.1 / §3.3 / §6.2: the prototype JUMP_RUN is keyed on the male **fist** RUN (0.8 s, right contact at 0), which
    only an unarmed male plays. Armed males play 0.666 s weapon RUNs (sword/spear/bow share legs within 3.2 cm) that
    start at left mid-stance, like the female RUN [confirmed: sidecar durations, `models.ts clipFor`,
    `factcheck2/family_run_feet.py`]. The "seamless exit" held only for unarmed males. JUMP_RUN is now authored per
    RUN leg cycle (male weapon first, female, then male fist), with `runJumps`, `enterPhaseS` and `exitPhaseS` in the
    index and the base resumed at `exitPhaseS`.
24. §6.2: `FAMILY_CLIP` does not give every family its own stand: sword/blade have only their RUN; bow its RUN and
    ATTREADY; spear/glaive STAND1, WALK, ATTREADY, RUN, STAND3 [confirmed: sidecar groups]. A player with no weapon
    has no family [confirmed: `entities.ts weaponFamily()`]. The standing arm layer is dropped for sword/blade (it
    would only freeze the arms at the idle JUMP was keyed from).
25. §4.1 / §4.2: the check order was wrong. `Gameplay.request` refuses `dead`, then runs the gates (mounts → alchemy →
    trade → stalls), and only then the module's `cant_act` / `busy` / `cooldown` [confirmed: `gameplay.ts` 716–721,
    312–318].
26. §4.3: trading refused the jump, although `TRADE_ALLOWED` already lets the harmless `emote` through (I8) and the
    user asked for "jump anywhere" [confirmed: trade.ts]. Now allowed (`TRADE_ALLOWED` += jump); no `trading` toast.
27. §4.2 / §5: a client gate and a server cooldown of exactly 1000 ms refuse about half the jumps of a player tapping
    at the gate's rate, whenever the second packet arrives faster than the first; the jumper sees them (prediction),
    the friends do not. `JUMP_COOLDOWN_SLACK_MS = 150` on the server.
28. §6.3: prediction while sitting shows no jump at all to the jumper: the server's `stand` posture broadcast makes the
    client play STAND_UP over the predicted JUMP, and the echo is then ignored [confirmed: posture.ts `emote`/`standUp`
    order, client `posture.ts`, `entities.ts setIdle`, `models.ts playAction`]. Prediction during an own skill action
    would stop the skill clip. No prediction in those states, nor mounted, stalling, dead or held.
29. §6.2 / §12 Q3: a click during a standing JUMP glided up to 6 m in a crouch, the look cut 6 calls broken. A move
    now cancels a grounded standing JUMP; only the air part plays over the slide.
30. §6.2: the JUMP_RUN phase seek and the viewer latency seek could add up past the take-off. They share the 200 ms cap.
31. §6.4 / §12 Q11: `audio/surface.ts` reads tile types only, and the coast's shallow sea lies over tiles retyped
    `Sand`, so a sea landing plays sand [confirmed: surface.ts, COAST §7.1]. A water-height check is a COAST seam.
32. §2.2 / §8.1: GRASS_LIFE fades its grass push above 0.5 m "over the ground", but a jump never lifts the entity
    position [confirmed: `entities.ts update`, GRASS_LIFE item-3 seam]. The index gets an `air` curve and MV-C a
    `jumpLift(view, now)`.
33. §3.2: the stiff forward arms remain at take-off and rise (96–102° flexion, 10–14° elbow; 90° is horizontal), for
    about 3 frames [confirmed: the table, `jump_filmstrip.png`]. It is now touch-up 0 and is pointed out to the user.
34. §3.2: the 9 mm planted slide is at the heel-down (667 ms), not the push; JUMP_RUN frame 0 is RUN @ 0 lifted ~1 cm
    by the contact solve, not "unchanged" [confirmed: `moves_keys.json`].
35. §2.2: `work/out-opt/char/_anims/europeman_skel/` holds 16 packs, not 14 [confirmed: `ls`].
36. §6.1 / §8.1: SCREENS does not edit `models.ts` (its §6.1 says so); the release workflow does, right now. The
    movement pack is loaded only by the world screen, not awaited, not on the character stages.
37. §7: the per-API headroom is now spelled out from the wave-9 gate numbers. The only preset/API where the synthetic
    worst case (+0.8 ms) crosses 16.7 ms is WebGL2 High in the crowd (16.0 → 16.8); WebGPU High fails without the
    jump. The NullEngine bench was re-run (loaded machine): the plain clips cost no more than idle; the arm layer's p95
    reached 1.5–1.7 ms in noisy rounds.
38. §8.2: the character stages' keys were re-checked (own `window` listeners, no `KeyMap`) [confirmed]; the Low guard
    also includes the release workflow's new low-guard tests.

Re-derived and **held** by the second pass: the polish metrics (apex 1.311 m, air 433 ms, feet clear 0.568 m, hands
1.833 m, JUMP_RUN apex 1.127 m, stance slide ≤ 0.7 mm, female apex 1.268 m and absorb 0.685 m, the failed female
JUMP_RUN at −0.893 m / 0.816 m); the pack sizes (78,436 / 34,564 B male, 85,428 / 37,550 B female, `br2.ts` re-run);
the round-trip numbers (0.031° / 7.8e-7 m male, 0.030° / 7.6e-7 m female); the thighs under `Bip01 Spine` on both
skeletons and `Bone01` under `Bip01 Spine1` (female); 225 clips; Space free (every `keys: [...]` registration listed,
`normalizeKey` lower-cases, keyhelp already prints `' '` as "Space"); `preventDefault` at hud/keys.ts 127 and
`isTypingTarget`; the emote precedent (protocol.ts 385–386 and 642–643, posture.ts 84–92); `p.cooldowns` (world.ts
106); `held` (engine.ts 511); `standUp` (posture.ts 95); the per-type rate limit is never a strike (connection.ts
`gameplay`); an unknown server frame is dropped with a `console.warn` (net/wire.ts, validate.ts `unknown message
type`); `MOUNTED_REFUSED`, `FUSE_CANCELLERS`, `STALL_ALLOWED`, `TRADE_BREAKERS`; `MOVE_CANCELS`; `playAction`,
`startUnblended`, `prepareGroup` 0.08, `lodTick`/`blending()`; animation LOD off on Low (`animLod` = `newLook`).

No download or upload is needed by the design. Route B (mocap) and route C (AI motion) would still need the user's
approval. The second fact-check downloaded and uploaded nothing, and started no server and no browser.
