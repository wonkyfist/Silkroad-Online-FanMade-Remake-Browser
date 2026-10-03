# @sro/fx

Silkroad skill and visual effects (EFP, `JMXVEFF`) played in Babylon.js at the original 20 Hz timeline.

## Pipeline

1. `packages/formats/src/efp.ts` parses `.efp` byte-exactly (JMXVEFF 0010-0013; 2,079 of the 2,086 files in
   Particles.pk2; the other 7 are an unrelated `0000` serialization no client file references).
2. `pnpm tsx packages/convert/src/tools/export-fx.ts` compiles every effect (`packages/convert/src/fx/compile.ts`)
   and writes `work/out/fx/` (served by the viewer at `/out/fx/`):
   - `efp/<particles path>.json`: one program per effect (format: `src/program.ts`, glTF space, metres, 20 Hz)
   - `tex/<particles path>.png`, `mesh/<particles path>.glb`: textures and meshes the programs use
   - `skills.json`: the Chinese masteries' skills with the effects of each phase (skilleffect.txt); each stage row
     also carries `dmg` (DMG Event), `kill` (ends earlier loops) and `sound` (SndBegin/SndEnd as prim/snd keys)
   - `index.json`: every exported effect plus the parse failures
3. This package plays a program: `FxSimulation` (engine-free) and `FxInstance` (Babylon geometry). `FxStreak` draws
   a textureless glowing strip for what has no program (arrow shafts, imbued weapon glows).
4. The game schedules them per skill in `apps/game/src/world/skill-fx.ts` (stages, DMG rows at their hits,
   projectiles, sparks, buff/imbue/status loops).

Game data should reference effects by key (the Particles.pk2 path, e.g. `skill/china/cold_ganggi_keep_a.efp`),
never by output file.

## Use

```ts
import { FxInstance, FxLibrary, nodePose } from '@sro/fx'

scene.useRightHandedSystem = true // programs are in glTF space
const fx = new FxLibrary(scene, '/out/')
const effect = await fx.load('skill/china/cold_ganggi_keep_a.efp')
const inst = new FxInstance(fx, effect, { pose: nodePose(handBone, characterRoot), loop: true })
// every frame:
inst.update(engine.getDeltaTime() / 1000)
// later: inst.stop() (let live elements finish; a stopped loop does not restart), inst.dispose()
```

Rendering builds each drawing node's geometry on the CPU (plates, meshes, camera-facing ribbons) and draws it with
an unlit `StandardMaterial` (texture x vertex colour; additive or alpha blend). Babylon ships that material in GLSL
and WGSL, so WebGPU and WebGL2 work without runtime shader downloads.

Preview: `pnpm viewer`, then `http://localhost:5173/fx.html` (see `apps/viewer/src/fx/main.ts` for the query string).

## Known approximations

- `ViewVBillboard` is drawn as a billboard around the element's own up axis (meaning unconfirmed).
- `RenderLinkPipe/LinkDPipe/LinkObj` are straight camera-facing strips between consecutive elements of a group
  (no spline smoothing); `LinkObj` is drawn like a pipe.
- The link flags `keepMatrix`/`keepOrigin` are kept but unused; every element exposes its per-tick motion to
  descendants that follow it.
- Rare blend pairs and texture-stage ops (0.2 % of nodes) map to the nearest of add / alpha blend / modulate.
- `SetRotation` flags are read as the basis (0 world, 1 own, 2 parent, 3 sibling), like the velocity commands.
