# Engineering conventions

Private research project: a browser recreation of Silkroad Online built with TypeScript, Babylon.js 9, and a Node server (later).
Reference client: **vSRO 1.188**. Its path is set in `sro.config.json`, which is gitignored.

## Hard rules

- **Never commit retail game data.** This covers PK2 files, extracted files, converted `.glb`, `.png`, `.dds` and `.ktx2` files, and table dumps. All of it lives under `work/`, which is gitignored.
  - Tests read the real client at runtime through `openArchive()`.
  - Tests skip when `sro.config.json` is missing.
- **Clean-room parsers.** Write parsers from the specs.
  - GPL, AGPL and unlicensed code may be *read* as documentation, but never copy it. This includes openroad, OpenSRO, RSBot, skrillax, websro and sro-web.
  - MIT code may be ported only with attribution in a comment. This covers Lafa2K and JMX-File-Editor.
- **`packages/formats` is environment-neutral.**
  - It takes `Uint8Array`/`BinaryReader` input and must not import `node:*`.
  - It will also run in the browser, in workers.
- **Handedness conversion happens in exactly one place: the glTF writer.**
  - Silkroad is left-handed and Y-up (Direct3D). glTF is right-handed and Y-up.
  - Parsers return **raw file-space values**: positions, quaternions exactly as stored, triangle winding as stored.

## Layout

```
packages/formats/src/   parsers: binary.ts, blowfish.ts, pk2.ts, ddj.ts, bms.ts, bsk.ts, ban.ts, bmt.ts, bsr.ts
packages/formats/test/  pure unit tests (synthetic buffers)
packages/convert/src/   Node CLI (cli.ts), node-io.ts (openArchive/FileSource/loadConfig), gltf/*, png.ts
packages/convert/test/  corpus tests against the real client (skip if no config)
apps/viewer/            Vite + Babylon.js viewer for work/out
work/extracted/<Archive>/  full extraction (Data, Map, Media, Music, Particles), handy for hexdumps
work/out/               converter output (served by the viewer)
```

## Code style

- TypeScript strict, ESM, 2-space indent, no semicolons, single quotes.
- Relative imports use explicit `.ts` extensions.
- Import the formats package as `@sro/formats` from `convert` and `viewer`.
- Keep comments sparse. Cite the spec in a header comment and explain non-obvious fields.
- `BinaryReader` (`binary.ts`) is little-endian. Joymax strings are `lpString()`: a u32 length followed by bytes, with no terminator. Resource paths are CP949/EUC-KR; pass the `eucKr` decoder.
- Resource paths inside files use backslashes and are relative to `Data.pk2`. Use `normalizePk2Path()` to look them up.
- Unknown or reserved fields are kept, as `unknown*` properties or raw bytes, rather than silently dropped.
- Parsers throw `Error` with the file offset on malformed input. They never return partial garbage.

## Specs (read these; cross-check at least two)

| Format | openroad (GPL docs: read-only) | SilkroadDoc wiki |
|---|---|---|
| BMS | https://raw.githubusercontent.com/ferdoran/openroad/main/docs/formats/bms-jmxvbms.md | https://github.com/DummkopfOfHachtenduden/SilkroadDoc/wiki/JMXVBMS |
| BSK | .../docs/formats/bsk-jmxvbsk.md | .../wiki/JMXVBSK |
| BAN | .../docs/formats/ban-jmxvban.md | .../wiki/JMXVBAN |
| BMT | .../docs/formats/bmt-jmxvbmt.md | .../wiki/JMXVBMT |
| BSR | .../docs/formats/bsr-jmxvres.md | .../wiki/JMXVRES |
| DDJ | .../docs/formats/ddj-jmxvddj.md | .../wiki/JMXVDDJ |

The MIT reference implementation (portable with attribution) is
https://raw.githubusercontent.com/Lafa2K/silkroad-blender5-skill-importer/main/silkroad_blender5_skill_importer.py

The srodevs GitBook (https://srodevs.gitbook.io, with ImHex patterns) is a third opinion.

## Census of this client (work/census.json)

- BMS: 0110 ×16,836 and 0109 ×17 (the 0109 files use 4 influences, 12 bytes/vertex).
- BSR: 0109 ×5,559, 0108 ×3, 0107 ×1.
- BAN: 0102 ×3,561, 0101 ×2, and 1 non-JMXV file.
- BSK: 0101 ×806, plus 3 empty files and 1 non-JMXV file.
- BMT: 0102 ×3,133.
- DDJ: 1000 ×32,663 across all archives.
- EFP: 0011 ×1,812, 0012 ×147, 0013 ×119, 0000 ×7, 0010 ×1.

## Test assets

| Role | Path in Data.pk2 |
|---|---|
| Character | `res/char/china/chinaman_adventurer.bsr` (also `chinawoman_adventurer.bsr`, `res/char/europe/europeman_adventurer.bsr`) |
| Weapon | `res/item/china/weapon/blade_01.bsr` |
| Monsters | `res/mob/china/mangnyang.bsr`, `res/mob/china/tiger.bsr`, `res/mob/china/tigerwoman.bsr` |

## Commands

- `pnpm sro info|ls|cat|extract|census`: CLI (`packages/convert/src/cli.ts`).
- `pnpm test`: all tests. `pnpm vitest run <file>` runs one file.
- `pnpm typecheck`: runs `tsc` (TypeScript 7).
- `pnpm sro convert <bsr...> [--out dir]` and `pnpm sro convert --preset m1`: BSR to glb + sidecar JSON under `work/out/<category>/`. Each glb is validated, and the entries are merged into `work/out/index.json`.

## Coordinate space & units

All of this is implemented in `packages/convert/src/gltf/space.ts`, the only file that changes handedness. It is unit-tested in `packages/convert/test/gltf-space.test.ts`.

| Quantity | Silkroad file space | glTF |
|---|---|---|
| Position | (x, y, z) | 0.1 × (x, y, −z) |
| Normal / direction | (x, y, z) | (x, y, −z) |
| Quaternion (x, y, z, w) | as stored | (−x, −y, z, w), i.e. M R M with M = diag(1, 1, −1) |
| Rigid transform (q, t) | as stored | (convert q, convert t) |
| Triangle | (a, b, c) | (a, c, b) |
| UV | as stored | unchanged |

- The rigid-transform conversion commutes with composition and inversion, so each bone's `toParent` is converted on its own.
- UVs need no change because Direct3D and glTF both put (0, 0) at the top-left texel.

**Handedness (measured).** In file space, models face −Z:
- toes point to −Z and the cloak hangs at +Z;
- the tiger's head is at z = −7.3 and its tail at z = +27.5;
- the `Bip01 L *` bones sit at +X.

A figure that faces −Z with +Y up and its left side at +X is left-handed. This matches a 3ds Max Biped (which faces −Y, left at +X, Z up) exported with Y and Z swapped (det −1). Mirroring Z gives a right-handed model that faces glTF's front (+Z) with its left side still at +X.

The Blender 5.2 glTF importer confirms the result on chinaman_adventurer.glb: `Bip01 L Hand` is at +X, the toes are toward Blender −Y (glTF +Z), and the renders are upright, textured and facing the camera.

**Winding (measured).** Every raw BMS triangle is stored so that cross(b − a, c − a) · normal > 0 (the Direct3D clockwise front face in a left-handed frame). Counts from the test assets:

| Asset | > 0 | < 0 |
|---|---|---|
| chinaman | 1330 | 0 |
| chinawoman | 1534 | 0 |
| europeman | 1486 | 0 |
| mangnyang | 477 | 0 |
| tigerwoman | 1937 | 0 |
| tiger | 818 | 6 |
| blade_01 | 61 | 2 |

The mirror flips that relation, so the converter swaps b and c. After the swap, glTF counter-clockwise front faces agree with the normals.

**Unit scale: 1 file unit = 1 dm, so the scale is 0.1.** Bind-pose heights, from the minimum to the maximum vertex Y:

| Model | Raw units | Height |
|---|---|---|
| chinaman_adventurer | 18.12 (feet −0.005, hair top 18.119) | 1.81 m |
| europeman_adventurer | 18.04 | 1.80 m |
| chinawoman_adventurer | 17.20 | 1.72 m |
| tigerwoman | 21.1 | 2.11 m |
| tiger | 19.7 | 1.97 m |
| mangnyang | 15.2 | 1.52 m |

`gltf.test.ts` checks that every character is 1.5–2.2 m tall, measured on the written glb.

**Skins.**
- **Joints and inverse binds.** Each BSK bone becomes a node with the converted `toParent` as its rest pose. Every bone is a joint. The inverse bind is the inverse of the node-hierarchy world transform.
- **Stored `toLocal`.** On all 6 skinned test assets, the inverse bind equals the stored `toLocal` (converted) to within 1e-3; the sidecar field `skeleton.bindCheck.staleToLocal` is empty.
- **Bind check.** The converter throws if bindWorld × inverseBind differs from I by more than 1e-4. The maximum measured is 1.1e-6.
- **Palettes and weights.** Mesh bone palettes map to joints by name. Weights are renormalized to sum to 1, and unused slots use joint 0 with weight 0.
- **Animations.** There is one glTF animation per BSR aniGroup entry that has a clip. It has rotation and translation channels for every joint (LINEAR):
  - BAN tracks for bones outside the skeleton are skipped and listed in the sidecar;
  - in full clips, bones without a track get a one-key rest channel (partial clips: see below);
  - consecutive quaternions are kept in one hemisphere.
- **Clip names.** A clip is named after its TYPE_NAME. The `default` group names first; collisions become `<TYPE>_<ban base>`, then `_2`, `_3`, and so on.
- **Cross-check against file-space skinning.** For chinaman RUN, `gltf.test.ts` compares CPU glTF skinning of the glb with skinning done directly in file space: BAN locals, world = parent ∘ local, skin = world ∘ stored `toLocal`, then converted. The maximum difference is 6e-7 m over every third key.

**Attachables (weapons, equipment).** A BSR whose skeleton names an `attachBone` (for example blade_01 → `Bip01 R HandMid`) is written as a static glb:
- no skin;
- the meshes stay in the item's model space;
- the item's bones (Bone01, ai_start, ai_end) become plain nodes.

**Attach rule ("SRO socket", the viewer's default `socket` mode):**

  item world = attachBoneWorld(t) × inverse(rotation(attachBoneBindWorld)) × v

The item hangs under the attach bone with only the bone's bind-pose world *rotation* cancelled; the translation stays at the bone. Items are therefore authored as if gripped by the character in the T-pose, with the blade pointing forward from the fist. Bone01's own bind is not applied, because it cancels under skinning.

- **Source:** OpenSRO's notes on the native client functions ABC680, AB5870 and AB68C0 (read as documentation only).
- **Evidence:** `verify.test.ts` check 5 measures the grip in the rest pose.
  - With the socket rule, the blade leaves the fist toward the index side (dot 0.97) and roughly perpendicular to the fingers (0.24).
  - Treating the bone's axes as the item's axes (the old `bone` mode, an earlier wrong conclusion) gives −0.05: sideways out of the fist, and pointing down during slashes.
- **User-confirmed:** the attach looked wrong under the old rule and correct under this one.

**Partial (overlay) clips.** A clip whose BAN tracks fewer than 0.8 × the joints of the resource's fullest clip (for example DAMAGE1 with 4 of 43, DEFENCE, STAND3) gets channels only for its tracked joints and `partial: true` in the sidecar. Players must layer it over the current full clip; the viewer plays it over the last full clip, STAND1 by default. Full clips give every joint a channel.

**Materials.**
- baseColor is the DDJ decoded to a PNG embedded in the glb. metallicFactor is 0, roughnessFactor is 1, and emissiveFactor is the BMT emissive RGB.
- doubleSided comes from BMT flag 0x1.
- BMT has only one alpha bit (0x200) and no test/blend distinction, so the texture's alpha histogram decides:
  - mostly 0 or 255 → `MASK` with cutoff 0.5;
  - more than twice as many partial-alpha texels (1–254) as zero-alpha texels → `BLEND`.
- Without 0x200 the material is `OPAQUE`. blade1_5's DXT3 alpha is a specular/env-map mask (64% of texels have alpha 1–127), not coverage.
- The sidecar records each decision and its reason under `materials[].alphaReason`.

## World space & region output

`pnpm sro convert-region --preset jangan` (or `--regions <x0>-<x1>,<z0>-<z1> [--centre x,z]`) writes `work/out/world/<name>/`. The code is in `packages/convert/src/world/`. The manifest schema is the TypeScript in `world/manifest.ts`, which also exports `validateWorldManifest`. The binary layouts, with their decoders, are in `world/format.ts`. Both files are node-free, so the viewer can import them through a relative path. The rendering rules come from `docs/TERRAIN.md`.

**Frame.** The output uses glTF space throughout: right-handed, +Y up, metres. It is produced only by `gltf/space.ts`: file (x, y, z) → 0.1 × (x, y, −z).
- File +X (east) stays +X. File +Z (north) becomes glTF **−Z**.
- A region is 1920 units = 192 m, a terrain cell is 20 units = 2 m, and there are 97 × 97 vertices per region.

**Floating origin.** The origin is the **south-west corner** of the preset's centre region, i.e. file-space region-local (0, 0, 0), the minimum x and minimum z, at height 0. For Jangan that region is 168,97 = 0x61A8. `manifest.space.originRegion` names the region, and `originCorner` is `'south-west'`.

**Region → world.** `region.origin = toGltfPosition([1920 (x − ox), 0, 1920 (z − oz)]) = [192 (x − ox), 0, −192 (z − oz)]` m.
- Region-local file units (lx, h, lz) map to `[origin.x + 0.1 lx, 0.1 h, origin.z − 0.1 lz]`.
- Terrain vertex (gx, gz) maps to `[origin.x + 2 gx, heightM, origin.z − 2 gz]`.
- A region therefore covers glTF x ∈ [origin.x, origin.x + 192] and z ∈ [origin.z − 192, origin.z].

**Terrain** (`terrain/<x>_<z>.bin`, 'SROT'). Arrays are gz-major.
- Heights in metres.
- glTF normals, computed with central differences across seams. The terrain itself is unlit.
- Raw `.m` texture words: id = w & 0x3ff, tiling code = w >> 13, periods 80/160/80/40/20 units.
- The native per-cell layer planes of TERRAIN.md 2.3, as RGBA8 96 × 96 per layer: [id & 0xff, id >> 8 | code << 2, mask4, 255]. The first layer is opaque.
- Triangles split along (gx, gz)–(gx+1, gz+1). `terrainIndices()` builds the glTF index buffer through `toGltfIndices`, and `terrainHeightAt()` is the matching height query.

**Lightmap and minimap.**
- The lightmap is `terrain/<x>_<z>_lightmap.png`, 512², with PNG row 0 = **south** (file z = 0).
- Border texels are shared with the neighbouring region, so `u = (0.5 + 511 lx / 1920) / 512`, likewise v with lz, and v = 0 is PNG row 0 (load with invertY false).
- `minimap/<x>x<z>.png` is the client's minimap tile, north-up, kept for verification.

**Navmesh** (`navmesh/<x>_<z>.bin`, 'SRON') comes from `.nvm`:
- the 97² heights (m), which equal the terrain exactly;
- the tile → cell map;
- cell rectangles in region-local file units (walkable iff index < openCellCount);
- edges with their flags;
- 6×6 water/ice planes in the manifest.

**Objects.**
- **Records.** `.o2` records (`.o` when a region has none) are deduplicated on (regionId, uid). Jangan: 3,065 records → 1,862 placements, 0 conflicts. Each placement's position is `toGltfPosition(1920 (owner − origin) + p)` and its rotation is `toGltfQuat(mapoYawQuat(yaw))` = +yaw about +Y.
- **Compounds.** A `.cpd` placement lists all its child models; its collision BSR is not drawn.
- **Conversion.** Every unique BSR is converted once with `convertResource` to `models/<path without res/>.glb` plus a sidecar. Skinned objects keep their clips; `model.defaultClip` is the first clip of the 'default' aniGroup.
- **Object lightmaps** (BMS 0x400, an additive `ConvertOptions.lightmaps`):
  - uv1 → `TEXCOORD_1`;
  - the mesh gets its own material variant with `extras.sroLightmap = { path, uri, texCoord: 1 }`, where `uri` is relative to `manifest.json` (`lightmaps/<Data path>.png`);
  - the viewer sets `lightmapTexture` with `coordinatesIndex = 1`;
  - how it combines with the rest is still unknown (TERRAIN.md 3.3).
- Callers that omit the option (`pnpm sro convert`) get byte-identical glbs to before.

**Verified** (`packages/convert/test/world.test.ts`, on 168,97 plus the neighbours 169,97 and 168,98):
- **Seams.** Heights and normals are bit-equal across both seams, and the origins agree.
- **Navmesh vs terrain.** The `.nvm` heights equal the `.m` terrain. Every tile centre lies inside its cell.
- **Placements vs the navmesh.** Placements coincide with the `.nvm` object list, including neighbour-owned objects, to within 1e-4 m.
- **Placements on the terrain.**
  - 168,97: 75.9% of static non-big placements lie within 1 cm of the terrain and 98.8% within 3 m.
  - All of Jangan: 64.5% and 98.2%, median 0.000 m.
- **Lightmap orientation.** The lightmap is darker at group-2 objects only under the documented UV rule: 20.0 against ≤ 8.4 for the flipped or transposed readings. It wins in 7 of the 9 Jangan regions, so the per-region signal is noisy.
- **Layer map orientation.** The layer map correlates with the client minimap only in the documented orientation: 0.34–0.67 against ≤ 0.39, in 8 of 8 field regions probed.

## Navigation

The rules are in `docs/NAVIGATION.md`; the code is `@sro/nav` (`packages/nav`, environment-neutral).

- **nav.bin.** `convert-region` writes `work/out/world/<name>/nav.bin`: `encodeNavData(buildNavData(...))` over the converted regions' `.nvm` files. It holds every object navmesh instance those object lists name, including big objects owned by neighbouring regions and `.cpd` compounds (through their collision `.bsr`). `manifest.nav` (`WorldNav` in `world/manifest.ts`) describes it. The per-region `navmesh/<x>_<z>.bin` files are still written.
- **Frame.** NavData is in world **file** space: decimetres, world = 1920 (rx, rz) + region-local. Load it with `new NavGltf(new NavWorld(decodeNavData(bytes)), manifest.space.originRegion)` to work in the manifest's glTF metres.
- **Height.** Take the height from the character's retained surface: `heightOn(leg.surface, ...)` along `moveStraight().legs`. Call `locate()` only for spawns and teleports, never every frame.
- **Spawn.** `manifest.spawn = { x, y, z, yaw, source }` is in glTF metres.
  - x and z come from the client's town return point: the `teleportdata.txt` row, which for Jangan is `GATE_CH` (region 25000, GenPos (969, 0, 1369), radius 150, CanBeResurrectPos 1), converted with `space.ts`.
  - y is `locate(x, z, GenPos_Y)`, which puts Jangan's spawn on the plaza at -3.261 m. The converter rejects a spawn on closed terrain, on a sealed navmesh, under another floor, or boxed in.
  - The client data has no facing, so yaw is 0 (`yawTowards` convention: facing south).
  - `world-nav.test.ts` checks the spawn against the render meshes and checks the plaza height against the original `npcpos.txt` NPC heights.
