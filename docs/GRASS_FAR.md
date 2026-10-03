# Grass to the horizon: the meadow ring and the far carpet (P-GRASS-FAR)

**Status (2026-10-01, the polish pass before the user's local test of wave 10r):** built and measured; not committed,
not deployed. Lane P-GRASS-FAR owns `packages/world-render/src/grass/**` and `packages/convert/src/world/grass.ts`
(unchanged in this pass).

The user's top complaint, made twice with screenshots (`wave11/grass-only-near-player.webp` in the Dropbox):

> "I want to be able to see the field loaded from far away. Right now I only see a portion of the grass loaded and the
> rest won't load the grass. It kills the immersion."
>
> "i also still dont see grass from afar, it cuts off"

**Tags.** **[confirmed]**: checked in the code, a test, a shot or a measurement, and the text says which.
**[projected]**: computed or estimated, not measured on that setup. **[decision]**: a choice this pass made (the user
delegated every decision; each is the recommended option).

---

## 0. Summary

1. **Why it cut off** [confirmed: `grass/cull.ts`, the "before" shots]. GL-F's field draws blades only to the far
   tier's edge, 58 m from the camera on Medium (82 m on High); its tier-0 blades thin out between 40 and 57 m. With the
   game camera 12–24 m behind the player that is 35–45 m past the player. Beyond it GL-T pulls the ground toward the
   palette's mid colour, but that is a flat colour with no blades, so the carpet's far edge reads as a line and the
   meadows beyond as bare.
2. **Three rings** [decision], each drawing what reads at its distance:
   - **A, near** (today's field, unchanged look): full blades and 3D flowers to 58 m (Medium) / 82 m (High).
   - **B, the meadow ring** (new): sparse three-blade tufts and flower dots from where ring A's last blades drop out to
     **≈ 255 m on Medium and ≈ 310 m on High** (± 20 m of world noise), in three nested sub-rings that keep the
     coverage while the tuft count falls (2.25 → 0.68 → 0.27 tufts/m² on Medium).
   - **C, the far carpet** (the terrain under every grass tile, from ring A's edge to the view distance): the palette
     colour, now with a tuft-scale pattern (darker roots, lighter tips) and a soft sheen sweeping downwind with the
     gust wave the blades bend with.
3. **No edge anywhere** [decision; confirmed by the tests and the shots]: ring B fades in exactly as ring A's tier-0
   blades drop out (the two presences sum to 1 across the band, `grass-far.test.ts`), and world-space value noise
   pulls that band, ring B's fade-in and ring C's ramp inward by up to 10 m together, so the hand-over wanders instead
   of drawing a circle. Each sub-ring is the previous one's survivors (one random sequence), so a cell's sub-ring never
   shows. Ring B's outer edge is a 40–60 m wide fade per tuft, moved ± 20 m by 90 m noise, inside the haze.
4. **Cost** (§5) [confirmed]: 3 more draws, 2 more textures (≈ 1.4 MB), + 0.40 M vertices and + 0.07 ms GPU at the
   user's spot on Medium WebGPU; the frame-time change is below the run-to-run noise on both backends and the G1 gate
   holds (§5). Low, Off and the Classic path are unchanged (the Low guard).

| | Before | After |
|---|---|---|
| The user's view, Medium, noon, clear | `work/tmp/w10p/grass-far/before-user-view-webgpu-medium.jpg` | `work/tmp/w10p/grass-far/after-user-view-webgpu-medium.jpg` (also Dropbox `wave11/grass-far-after-user-view.jpg`) |
| A lower camera, same spot | `work/tmp/w10p/grass-far/before-low-cam-webgpu-medium.jpg` | `work/tmp/w10p/grass-far/after-low-cam-webgpu-medium.jpg` |
| The sheet | | `work/tmp/w10p/grass-far/grass-far-before-after.jpg` (also in Dropbox `wave11/`) |

---

## 1. The rings per level

| Grass (Options) | Ring A (near) | Ring B (meadow ring) | Ring C (far carpet) | Band noise |
|---|---|---|---|---|
| Off | none | none | off (no tint) | — |
| Low (the Mac / iGPU default) | today's (8 / 19 / 35 m) | **none (today's)** | today's flat tint | 0 (today's) |
| Medium | today's (14 / 32 / 58 m) | 34–57 m → 255 m ± 20 | pattern + sheen | 10 m |
| High (and Ultra) | today's (20 / 46 / 82 m) | 50–81 m → 310 m ± 20 | pattern + sheen | 10 m |

The Classic path (Low preset) never makes a field, so none of this reaches it [confirmed: seams-classic,
release-lowguard, abuse-w9f-lowguard, abuse-w10r-lowguard green].

## 2. Ring B, the meadow ring (`grass/ring.ts`, `ring-shaders.ts`)

### 2.1 Geometry

- **Same scheme as ring A** [decision]: one shared patch mesh per sub-ring holds every tuft of one **16 m cell**; the
  cell's thin instance is only its corner; the vertex shader reads the ring window (§3) for the density, meadow mask,
  palette slot, baked light and ground height. One draw per sub-ring: **3 draws** for the whole ring.
- **A tuft** = 3 blades, one triangle each (9 vertices), fanned in the plane facing the camera (± 20° twist), the side
  blades 74 % as tall and leaning out: a tufty silhouette at 2–10 px. Heights 0.32–0.68 m × the density (ring A's
  blades are 0.30–0.72 m), the near blades' palette, painted hue patches and dry straw, the same root-to-tip gradient
  and shade, so a tuft and a far blade are the same colour [confirmed: the shots].
- **Sub-rings** (Medium; High in brackets): B1 every tuft, 24 × 24 per cell = 2.25 /m² (26²: 2.64 /m²); B2 the 30 %
  with the lowest keep value; B3 the 12 %. A dropped tuft shrinks away at its own random distance in the thinning
  band (B1 → B2 80–112 m [110–150], B2 → B3 140–180 m [190–240]); the survivors grow by `1/√share` in width and spread
  and `share^-1/4` in height, so the covered area stays close to even. B2's patch is exactly B1's survivors and B3's
  B2's (`buildRingPatch`, one random sequence) [confirmed: test].
- **Flower dots** [decision]: 16 % of the tufts carry a 4-vertex camera-facing diamond in the petal colours, in the
  meadow mask, ≥ 1.6 px wide; they fade in where ring A's 3D flowers fade out (flowers × 0.7 .. flowers: 18–26 m
  Medium) and out by 105–140 m (150–200 m High). B1 and B2 only.
- **Pixel floor:** every blade is at least ≈ 1 px wide at mid-height (ring A's rule), so no tuft shimmers into
  sub-pixel slivers.
- **Never batched** (tagged `metadata.sroWorld = 'scatter'`, BATCHING D7), never pickable, no shadow casting, and **no
  CSM tap** [decision: "shadows only for the near ring"]: the ring's material refuses `SRO_GRASS_CSM` (it takes every
  other define of the grass chunk graph: HDR light, weather, night lights, cloud shadow, fog). It reads the baked light
  (the terrain lightmap in the window's A channel) instead.

### 2.2 Distances, from the camera, 2D

| | Medium | High |
|---|---|---|
| Ring A's tier-0 cut-off = ring B's fade-in | 40–57 m (− band) | 56–81 m (− band) |
| B1 → B2 thinning | 80–112 m | 110–150 m |
| B2 → B3 thinning | 140–180 m | 190–240 m |
| Outer cut-off (per tuft) ± 20 m noise | 205–255 m | 265–310 m |
| Flower dots | 18–26 m in, 105–140 m out | 25–36 m in, 150–200 m out |

### 2.3 The hand-overs

- **A → B** [confirmed: `grass-far.test.ts`, the presences sum to 1 ± 0.03 over the band]: ring A's tier-0 blade
  disappears over `[cut0 − 6, cut0]` with `cut0` random per blade in `cut0`'s range; ring B's tuft appears over
  `[in − 6, in]` with `in` from the same range. **Band noise** [decision]: value noise at 0.027 /m (≈ 37 m blobs) moves
  `cut0`, `in` and ring C's ramp inward by the same 0–10 m at a point, so the band is irregular and the three stay in
  step. Inward only, so ring A's blades never pass its cell cull.
- **B1 → B2 → B3**: a tuft a sub-ring drops is gone before the next sub-ring's cells start (tested for every tuft).
- **B → C**: each tuft's own cut-off in a 50 m range, ± 20 m of 90 m noise, a 12 m shrink: the last tufts melt into
  the carpet over 40–60 m, never on a circle. The window's reach (≥ 352 m) covers the farthest tuft (330 m).

## 3. The ring window (`grass/ring-window.ts`)

- **832 m square at 2 m per texel** [decision], camera-centred, re-centred every 48 m: `field` 416² RGBA8 (density,
  meadow, palette slot, baked light) and `heights` 417² RGBA8 (16 bits over the window's range, the terrain's own 2 m
  vertices: the terrain has no LOD, so the tufts sit exactly on the drawn ground) [confirmed: test, within the 16-bit
  step]. A 52² cell table (max density, height range) feeds the CPU cull.
- **Data**: each region's ring-A bake (192² at 1 m) boxed to 96² at 2 m (`coarseGrass`: mean density, meadow and light,
  the densest texel's slot) when its bake, light or sea clearing lands (≈ 0.3 ms per region) [projected].
- **Fill in slices** [decision]: ≈ 3 ms of row work in all, so it runs in ≤ 0.6 ms row slices into a back buffer while
  the front keeps drawing; the buffers swap and upload (≈ 1.4 MB) when it is done. A region change marks it dirty; a
  new fill starts when the running one ends (§5: ≈ 5 slices of 0.6–0.8 ms, worst 1.4 ms, plus the swap frame's
  0.3–0.6 ms upload; one 3.3 ms slice during the initial load, `stats.ringWorstSliceMs`) [confirmed].
- **Stream reach**: Medium loads regions to 400 m, High to 480 m, so the bakes exist past the ring's edge
  [confirmed: `stream.ts`].

## 4. Ring C, the far carpet (`grass/chunks.ts`, `grass/tint.ts`)

GL-T's terrain extern `sroGrassTint` keeps its density (the splat's grass layers), table, palette and fade, and gains:

- **The band noise** on its ramp (`sroGtLook.y`), the same noise as rings A and B.
- **The tuft pattern** (`sroGtLook.x`): three octaves of value noise (0.43, 1.25 and 3.4 m) scale the palette's mid
  colour between darker, cooler roots (× 0.68–0.75) and lighter tips (× 1.25–1.32); the mean stays the mid colour GL-T
  matched with the carpet. Each octave fades where its wavelength nears the pixel footprint along the view
  (`distance × GRASS_TINT_PX / sin(grazing)`), because the extern runs after the layer loop where WGSL uniformity rules
  out derivatives [decision].
- **Shaded roots under ring B** (`sroGtLook.zw` = ring B's outer fade): the ground between the tufts is × 0.86
  (`GRASS_TINT_RING_SHADE`), back to the plain carpet over the ring's outer fade, so the tufts and the ground between
  them read as one carpet instead of tufts on a lighter lawn [confirmed: `shots/cmp-shade-v1-v2.jpg`].
- **The wind sheen** (`sroGtWind`): the gust wave the blades bend with (`sroWind`'s phase, 18 m, 6 m/s downwind) and a
  slow 78 m swell brighten the carpet by up to ≈ 10 % (× the weather's wind strength, 35 % at calm); ring B's tips
  carry the same sheen, so the bands sweep over tufts and ground together. The wind is the weather's `wxB` (direction,
  strength, its sway clock), else a calm breeze.
- **Low**: the shares, the band and the ring range are 0, so the output is today's [confirmed: test].
- **No normal change** [decision]: the extern returns albedo only (the terrain plugin is RND-T's); a blade-scale
  normal would need a new extern seam. The pattern and the sheen carry the "carpet" look instead.

## 5. Budgets and measurements

The bench: the dev PC (Ryzen 5 9600X, RX 9060 XT), the production bundle on a private preview and a private server
(a temporary data folder, `WORLD_EXPORT=jangan-fields`), 1920 × 1080, scaling 1, 300–400 frames per run after
streaming idled, GPU lock held. Both bundles were built from the same tree, the before bundle with this lane's files
from HEAD (a scratch Vite loader), since other lanes edited the tree during the pass. Spots: **wide meadow** = the user's spot (`/tp 114 93`, camera α −1.45, β 1.10, r 24, the
user's screenshot), **plaza** (101, −70 looking north), **crowd** (20 monsters at the plaza).

**The machine was busy** during this pass (other agents' builds, tests and a whole-disk `find`; total CPU 70–97 %
at the start), so every frame time is ≈ 2× the wave-10r final gate's quiet-machine numbers (plaza p95 3.6 ms then)
and swings ± 2–3 ms run to run. The comparison is therefore **interleaved A/B in one page**: the after bundle, the
ring and the carpet switched off (ring hidden, band 0, the tint's look 0) and on, alternately, 300 frames each, at
the same spot and moment [confirmed: `work/tmp/w10p/grass-far/shots/gf-ab-*.json`]. GPU = WebGPU timestamp sum
(p50); WebGL2 has no timer.

| Backend, preset | Scene | Frame p95 off (4 runs) | Frame p95 ring (4 runs) | Median off → ring | GPU off → ring | Grass vertices off → ring | Draws |
|---|---|---|---|---|---|---|---|
| WebGPU Medium | wide meadow | 9.3 / 9.2 / 9.7 / 5.8 | 11.1 / 10.0 / 9.0 / 6.0 | 9.3 → 9.5 | 1.45 → 1.52 ms | 0.32 M → 0.72 M | +3 |
| WebGPU Medium | plaza + 20-mob crowd | 9.5 / 11.5 / 13.3 / 9.2 | 8.9 / 10.0 / 10.0 / 11.3 | 10.5 → 10.0 | 1.78 → 1.85 ms | 0.01 M → 0.37 M | +3 |
| WebGL2 Medium | wide meadow | 3.2 / 5.9 / 4.2 / 9.0 | 3.6 / 8.6 / 4.6 / 5.6 | 5.1 → 5.1 | — | 0.32 M → 0.72 M | +3 |
| WebGL2 Medium | plaza + 20-mob crowd | 7.7 / 8.4 / 7.6 / 13.1 | 7.9 / 6.4 / 6.5 / 9.1 | 8.1 → 7.2 | — | 0.01 M → 0.37 M | +3 |
| WebGPU High | wide meadow (3 runs) | 7.6 / 8.0 / 8.2 | 8.4 / 7.7 / 7.7 | 8.0 → 7.7 | 2.13 → 2.13 ms | 0.82 M → 1.46 M | +3 |

- **G1 holds** [confirmed]: every Medium p95 with the ring is under 16.7 ms on both backends, under this load (worst
  11.3 ms WebGPU, 9.1 ms WebGL2). The ring's own cost is below the run-to-run noise: + 0.07 ms GPU (WebGPU), the
  field's cull and ring update together ≤ 0.1 ms CPU (p95 over 91 frames; Chrome's timer is 0.1 ms), + 3 draws.
  **WebGL2 did not need a shorter ring.**
- The first bundle-against-bundle pass (`gf-before-webgpu.json`, `gf-after-webgpu.json`) measured the crowd right after
  spawning the 20 mobs in the after bundle only: 18.3 ms p95 there (CPU 17.8, GPU 1.79), a spawn transient (the models
  and their effects arriving) on the busy machine; the same scene with the mobs already standing measured 9.9 ms
  (`gf-after2-webgpu.json`) and 8.9–11.3 ms in the A/B pairs, the before bundle 9.8 ms.
- **The ring window**: a fill is ≈ 5 slices of 0.6–0.8 ms (worst 1.4 ms) plus a 0.3–0.6 ms texture upload on the
  swap frame, once per 48 m of travel or region change [confirmed: instrumented in game]. Memory: ≈ 2.8 MB of CPU
  buffers (two windows), ≈ 1.4 MB of textures, 37 KB per region of boxed bake.
- The plaza draws the ring's cells in the fields behind the town wall (0.36 M vertices, no occlusion culling); GPU
  + 0.07 ms there.

## 6. Decisions (taken for the user, each the recommended option)

1. **Three rings, ring B as GPU-procedural tufts on 16 m cells** (the near field's proven scheme: no per-tuft CPU work,
   one draw per sub-ring) rather than camera-facing cards (alpha-tested, overdraw) or a longer near field (its 45
   blades/m² to 250 m would be ≈ 20× the vertices).
2. **Three-blade tufts, not single wide blades**: a tuft keeps a grass silhouette at 2–10 px where ring A's far tier
   reads as spikes; 9 vertices per tuft.
3. **Reach**: Medium ≈ 255 m (the haze of a clear noon closes in from ≈ 190 m: the linear fog's start), High ≈ 310 m;
   both inside the 400 / 480 m stream radius and the ring window's 352 m reach.
4. **One more window at 2 m** (832 m, ≈ 1.4 MB of textures) filled in slices from 2 × 2 boxed bakes, instead of
   enlarging the near window (1 m texels to 832 m would be ≈ 11 MB and a 10 ms fill).
5. **Band noise of 10 m** on all three hand-overs, inward only.
6. **No CSM tap on ring B** (the task's "shadows only for the near ring"); ring B reads the baked light.
7. **Ring C stays an albedo extern** (no normal seam in RND-T's terrain plugin this pass); the tuft pattern and the
   wind sheen carry the carpet look; Low keeps today's output exactly (shares 0).
8. **Grass: Low keeps today's field** (no ring, no band, plain tint), as the task asks; the Mac / iGPU default
   therefore gets nothing new until a friend's machine is measured.
9. **Flower dots fade in where the 3D flowers fade out** (18–26 m Medium), so the meadows keep their colour flecks
   into ring B instead of losing flowers between 26 m and the ring.
10. **The private bench server ran on a fresh temporary data folder** (the harness registers its own throwaway
    accounts and makes them GM there), not on a copy of `work/server/game.db`, which the running dev server holds open
    in WAL mode; nothing of the real database was read or written.

## 7. Not done, risks, follow-ups

- **WebGL2 shows black blotches on the far terrain** (beyond ≈ 60 m: the crop fields, the far road, the hills), in
  the **before** build as well [confirmed: `work/tmp/w10p/grass-far/shots/before-user-view-webgl2-medium.jpg`, ANGLE /
  D3D11 on the RX 9060 XT]. Not this lane's: switching off the CSM, the terrain lightmap, the cloud shadow, the IBL
  and the fog each left it unchanged (`shots/diag-webgl2-*.jpg`); the blocky, tile-shaped edges point at the terrain
  tile arrays' small mips on WebGL2 [likely]. Ring B and the tint cover the meadows there; roads and fields stay black.
  It needs its own look before the release (WebGL2 is the fallback path).
- **Weaker GPUs** (the friends' Macs and iGPUs) are not measured: they start at Grass: Low, which keeps today's field;
  on Medium the ring adds ≈ 0.4 M vertices per frame in a wide meadow [projected from the counters].
- **High** draws ≈ 1.46 M grass vertices at the user's spot (ring A 0.82 M, ring B 0.64 M) [confirmed: counters];
  the meadow A/B above shows no frame-time change; High's plaza and crowd budgets (G2) were not re-run here.
- **No blade-scale normal in ring C** (§4): a later pass could add a normal seam to the terrain plugin (RND-T's file).
- **Ring B's sheen and ring C's** follow the weather's wind clock; with Weather: Off a calm breeze on the field's own
  clock drives them [decision].
- **Ultra** uses High's numbers (GRASS_LEVELS has no Ultra row), as before.
- The user's request "also jumping needs to be a bit higher" is another lane's (MOVEMENT); not touched here.

### 7.1 Wave 11 GF-R (the remainder; WAVE_PLAN7 lane GF-R, Q16)

- **The WebGL2 blotches are gone**: the polish pass's texture-array fix (every mip level of the terrain tile arrays is
  uploaded on WebGL2 again) was the cause; GF-R's shots of the user's view on `?engine=webgl` show the far fields, the
  road and the hills without black tiles, and X1's check agrees.
- **Grass: Low gets a B1 meadow ring** (`grass/cull.ts`, the Low row only): B1 tufts only, out to ≤ 150 m, one draw, a
  sparser grid (16, about 0.44 of Medium's B1) with wider blades, fading in where Low's near blades end; no band noise,
  no carpet pattern or sheen, so Low's near field and tint stay today's. The A/B (WebGL2 and WebGPU, ring on/off, 4
  runs each, `work/tmp/gf-r/shots/gfr-lowring-ab-*.json`) is within the bench's noise: the ring costs about one draw.
  Cut 18 stays available if a Mac or iGPU measurement says otherwise.

## 8. Files

| File | What |
|---|---|
| `packages/world-render/src/grass/ring.ts` | ring B: patches (B1/B2/B3), the cull, the share |
| `packages/world-render/src/grass/ring-window.ts` | the 832 m ring window at 2 m, `coarseGrass`, the sliced fill |
| `packages/world-render/src/grass/ring-shaders.ts` | ring B's WGSL and GLSL body on the grass skeleton; TS twins |
| `packages/world-render/src/grass/cull.ts` | the levels: `band`, `ring`, `carpet`; `ringReach` |
| `packages/world-render/src/grass/field.ts` | GrassField draws ring B (3 meshes, its material, window, wind) |
| `packages/world-render/src/grass/shaders.ts` | `grassHeightFn`, the skeleton's window size, ring A's band noise |
| `packages/world-render/src/grass/chunks.ts`, `tint.ts` | ring C: the band, the tuft pattern, the sheen |
| `packages/world-render/src/grass/index.ts` | exports |
| `packages/world-render/test/grass-far.test.ts` | the new tests (19) |
| `packages/world-render/test/grass-cull.test.ts`, `grass-chunks.test.ts` | updated for six meshes and the two new tint vectors |
| `packages/world-render/test/material-budgets.test.ts` | one registry line: the ring's material (additive, outside the lane) |
