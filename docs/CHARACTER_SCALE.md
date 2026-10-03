# Player character scale

How tall the player character should be relative to the world, and what the original client's Height/Volume
character-creation choices do. Written for the world viewer and the game client.

Status tags follow `TERRAIN.md`: **[verified]** checked against our own data, **[likely]** one or more
sources say so (usually OpenSRO's reverse-engineering notes) and nothing contradicts it, **[estimate]**
a measurement with a stated uncertainty, **[unknown]** open.

## Summary

- The creation screen has five choices for Height and five for Volume (index 0 to 4). Both default to the
  middle value, 2. **[likely]**
- The single `Scale` byte in the create and character-list packets holds both. The low nibble is Height
  and the high nibble is Volume, so the default byte is `0x22`. **[likely]**
- Height is a uniform scale of the whole character: `heightScale = 0.94 + 0.03 * h`, which gives
  `[0.94, 0.97, 1.00, 1.03, 1.06]`. The default is 1.00. **[likely]**
- Volume is **not** a uniform scale. It thickens or thins a few bones radially, and the character's height
  stays the same. **[likely]**
- Our converted `chinaman_adventurer` at scale 1.0 is 1.82 m in its STAND1 pose (hair top) and 1.81 m in
  its bind pose. That is the correct size for a **default** (h = 2) character. **[verified]** for our data.
- The biggest possible Height choice is +6%, which makes him 1.93 m. Headgear adds 5 to 12 cm to the
  silhouette and shoes add about 1 cm. A photo check of the original game puts a real player at 1.07 ± 0.05
  of our scale-1.0 size. **[estimate]**
- **Recommendation:**
  - Implement Height as `0.94 + 0.03 * h`, applied as a uniform scale of the character and its
    attachments, and to the follow-camera target height.
  - Keep `h = 2` (1.00) as the default for new characters.
  - Give the viewer's demo player `h = 4` (1.06). The user asked for "a tad bit taller", and the photo
    estimate agrees. Do **not** use a factor above 1.06.
  - Fix the navmesh surface first. The player was sunk about 1.5 m into the plaza, and that was most of
    the "too small" impression.

## Evidence

| # | Question | Source | What it says | Weight |
|---|---|---|---|---|
| E1 | Which controls exist | `Media/resinfo/pscharactercreatechina.txt` (our data) | Section `Custom` has `GDR_SLI_FIGURE`, `GDR_SLI_HEIGHT`, `GDR_SLI_VOLUME`, `GDR_SLI_PROTECTOR` and `GDR_SLI_WEAPON`, plus the Male/Female buttons. `pscharactercreate_europe.txt` is the European equivalent. | verified |
| E2 | Their English labels | `textuisystem.txt` (our data) | `UIO_NEWCHAR_STT_FIGURE` = Figure, `_HEIGHT` = Height, `_VOLUME` = **Body**, `_PROTECTOR` = Cloth, `_WEAPON` = Arms. The Korean labels are 신장 (stature) and 체형 (build). | verified |
| E3 | Wire format | SilkroadDoc wiki `AGENT_CHARACTER_SELECTION_ACTION` (1.188) | Create is `action u8, name, RefObjID u32, Scale u8`, followed by 4 item ids (mail, pants, boots, weapon). Each entry of the character list carries `Scale u8`. No bit layout is documented. | documented |
| E4 | Pass-through servers | go-sro `char_selection_action_handler.go`; skrillax `charselect.rs`, `character.rs` | Both store `scale: u8` as received and echo it back. Neither interprets it. | documented |
| E5 | Default byte | openroad `client/src/scenes/intro_v2/character_create.rs` (`DEFAULT_SCALE`) | A live capture (`packet_dump/0xb007.log`) of a character made with the **original** client and untouched sliders carries `0x22`. openroad says the packing is unknown, and it renders `1 + byte/255` (= 1.133) as a placeholder. That formula is a guess; do not use it. | independent capture: strong for `0x22` |
| E6 | Bit packing | OpenSRO `apps/server/internal/agent/api/characters.go` (`bodyShape := (volumeIndex << 4) \| (heightIndex & 0x0f)`, comment: "the client decodes heightIndex from the LOW nibble and volumeIndex from the HIGH nibble"); `domain/appearance.go`; client `foundation/animation/body-shape.ts` (`bodyVolumeIndex`: `packed >>> 4`, clamped 0–4, `>= 8` → 0, `255` → 2) | Low nibble = Height, high nibble = Volume. `0x22` = (2, 2) matches E5. | likely (RE notes plus the E5 match) |
| E7 | Number of options and the default | OpenSRO `foundation/ui/character-create.ts` (`initialCreation`: `height: 2, volume: 2`; `creationRange`: 0..4) | 5 steps each, default 2. | likely |
| E8 | Height factor | OpenSRO `character-create.ts` (`heightScale: .94 + s.height * .03`), `appearance.go` (`0.94 + clamp(h, 0, 4) * 0.03`), `rendering/dock-camera.ts` (native `sub_738A90`: the select-screen camera focus scales with it), `body-shape.test.mjs` (1.06 at h = 4, 0.94 at h = 0) | A uniform model scale of 0.94 / 0.97 / 1.00 / 1.03 / 1.06. It blends linearly over 1 s when the slider changes (native 6D0B40 / 6D08C0). | likely |
| E9 | Volume | OpenSRO `body-shape.ts` (`bodyBoneScale`, native 8E7E00, tables CCCF08/CCCF68, applied by AB6B20 to the radial Y/Z rows of the skin matrices only) | At v = 0 the factors are: Spine 0.88 (female 0.95), Spine1 0.95, UpperArm 0.92/0.95, Thigh 0.90, Pelvis 0.90, female Bone01 0.80. At v = 4 they are 1.10, 1.11/1.00, 1.20/1.15, 1.15, 1.00/1.08, 1.18. Linear in between, and 1.0 at v = 2. Children and sockets are not moved, so **height does not change**. | likely |
| E10 | Is Height applied in the world? | OpenSRO `enterworld/entry.go` (`CameraHeight: ResolveCharacterCameraHeight` = 20 units × heightScale); its world renderer still draws players at `baseScale = 1` × the hwan (berserk) scale (`runtime/characters/characters.ts`, `effects.ts appearance()`). openroad draws world players at 1.0. | OpenSRO feeds the factor into the in-world follow camera, but neither project scales the in-world mesh yet. That the native client scales the world mesh too is **likely but not RE-confirmed**. E12 is weak support. | open (leaning yes) |
| E11 | Model scale column | `characterdata` (our data) | Scale = 100 for every `CHAR_CH_*` player row and for the Jangan NPCs `NPC_CH_SMITH`, `_ARMOR`, `_HORSE` and `_SPECIAL`. No other per-model scale exists. | verified |
| E12 | Photo check against the original game | srolobby.com "Silkroad Online – Jangan NPCs", `image/silkroad/npc/jangan/2_2.png` (1456×579; a player and Protector Trader Mrs Jang in front of the Protector shop, original client) | See the photo check section below. The player appears **1.07 ± 0.05** times the size of a scale-1.0 male, measured against the NPC. | estimate |
| E13 | Our converted sizes | `work/out/char/china/*.json` and a skinned-pose evaluation of the GLBs (scratch script, since deleted) | Male: STAND1 top 1.821 m, head joint 1.605, pelvis 0.998. Bind pose: top 1.812, head 1.595. Female: head joint 1.531 (bind). All 13 male and 13 female figures share one skeleton, so they all have the same height. Mrs Jang (`chinashop_dignifiedgirl`) STAND1: top 1.676, head 1.418. | verified |
| E14 | Equipment | converted `res/item/china/man_item/{clothes_01,clothes_05,heavy_01}_fa.bsr`, `{clothes_01,heavy_01}_ha.bsr` | Shoe soles reach y = −0.010 m (+1 cm). The cloth hat top is at 1.859 m and the heavy helmet top at 1.936 m, against 1.812 m bare hair (bind pose). | verified |
| E15 | Props against real-world furniture (sanity check only) | Horizontal-surface histograms of the Jangan GLBs | `cj_table_chair`/`cj_table01`: bench 0.50 m, table top 0.85 m (real: 0.45 / 0.74). `cj_armo` steps rise 0.19 m each to a 0.58 m porch. `cj_pal_center_stair` rises 0.25 m. The street-stall counter is 1.0 to 1.14 m. Lamps are 1.99 m (`cj_lamp01`), 2.39 m (`c_sta_01`) and 2.59 m (`cj_pal_lamp`). The props are 10 to 25% oversized for a 1.8 m man, which is normal game exaggeration. They cannot decide the question, because the artists may never have scaled them to the character. | context |

Sources: SilkroadDoc wiki (github.com/DummkopfOfHachtenduden/SilkroadDoc), openroad (github.com/ferdoran/openroad),
OpenSRO (github.com/opensro-dev/opensro, v1.150 client with native addresses), go-sro (github.com/ferdoran/go-sro),
skrillax (github.com/kumpelblase2/skrillax). All were read as documentation only (GPL/AGPL/unlicensed); nothing was copied.
Web guides only confirm that Height and Volume are cosmetic, and they give no numbers.

## Scale formula

```
byte  = (v << 4) | h          // h = Height 0..4, v = Volume 0..4; default 0x22
h     = byte & 0x0f           // clamp 0..4
v     = (byte >> 4) & 0x0f    // clamp 0..4; byte 0xFF -> v = 2; v >= 8 -> 0 (OpenSRO body-shape.ts)
heightScale = 0.94 + 0.03 * h                   // uniform, whole character + attachments
cameraTargetHeight = 20 units * heightScale     // 2.0 m at h = 2 (OpenSRO entry.go)
volume: per-bone radial factor f(v) = v <= 2 ? low + (1 - low) * v / 2 : 1 + (high - 1) * (v - 2) / 2
        on the Y/Z rows of the bone's skin matrix only (the table is in E9)
final render scale = (characterdata Scale / 100) * heightScale * hwanScale
```

| h | factor | STAND1 top (bare) | with heavy helmet (approximate) |
|---|---|---|---|
| 0 | 0.94 | 1.71 m | 1.83 m |
| 1 | 0.97 | 1.77 m | 1.89 m |
| 2 (default) | 1.00 | 1.82 m | 1.95 m |
| 3 | 1.03 | 1.88 m | 2.00 m |
| 4 | 1.06 | 1.93 m | 2.06 m |

The helmet column adds 0.124 m × factor to the STAND1 top, using the bind-pose helmet excess from E14.

## Photo check against the original game (E12)

- **Method.**
  - The world is already self-consistent with the navmesh, so the check compares the player with an NPC
    rendered in the same frame. The NPC is at characterdata Scale 100 and has no body-shape byte.
  - Mrs Jang's feet are at image y ≈ 513.5 and the player's at ≈ 534.5 (the lowest point of the boot tips,
    under the robe), so the two stand at nearly the same depth.
  - Landmarks were read at 2.3× zoom:
    - Player: eyes y ≈ 158.5, chin ≈ 172.5.
    - Mrs Jang: eyes ≈ 216.6, chin ≈ 230.6.
- **Measured.**
  - Feet-to-chin is 362 px against 283 px (ratio 1.28).
  - Feet-to-eyes is 376 px against 297 px (ratio 1.27).
- **Expected at player scale 1.0.**
  - Our STAND1 poses give head-joint heights of 1.605 m and 1.418 m, a ratio of 1.13.
  - Face landmarks sit near the head joint in both models, so the ratio of 1.13 carries over to them.
- **Perspective.**
  - The player stands about 21 px lower on screen, so he is closer to the camera.
  - For a follow camera 1.5 to 2.5 m above the ground, this inflates his size by 4 to 7%.
  - After correction the measured ratio is 1.19 to 1.23, which puts the player at **1.05 to 1.09 × our
    scale-1.0 male**.
  - Adding the landmark-reading error (about ±2%) and the landmark-offset assumption (about ±2%) gives
    **1.07 ± 0.05**.
- **Reading.**
  - The result is consistent with Height 3 or 4 (1.03 / 1.06).
  - It weakly disfavours the default 1.00 for *this* player. That player's Height choice is unknown.
  - It is inconsistent with 0.94. It sits at the edge of openroad's guessed 1.133.
  - A single image of a player with an unknown Height choice cannot pin the default. That part rests on
    E5 to E8.
- **Stronger check for the lead** (needs pixel access or a local capture):
  1. Take several original-client screenshots in which a player and an NPC stand side by side at equal
     depth. Feet on the same screen row is the best case.
  2. Measure feet to eye level for both and divide by 1.13 (male against Mrs Jang). For other NPCs,
     divide by the ratio of their STAND1 head joints.
  3. Better still, take a same-spot screenshot pair: the original client and our viewer, same camera
     pitch and distance, the player on the `cj_armo` steps (three 0.19 m risers to a 0.58 m porch) or next
     to a `cj_lamp01` (1.99 m). Then compare player height ÷ riser height.

## Why the player looked too small in our viewer

1. **He was sunk into the plaza** by about 1.5 m. The terrain-only height put the plaza floor at −3.30
   against the terrain's −4.79, so only his head and shoulders showed. The navmesh workflow fixes this.
   It was the dominant effect.
2. **Height choice.** Players who picked a taller Height stand up to 6% taller (+11 cm). The user's own
   character was probably h = 3 or h = 4. This is a guess, supported by E12.
3. **Headgear and clothing.** Our demo player is the bare base body. Real characters wear hats or helmets
   (+5 to +12 cm of silhouette) and bulkier armour. Shoes add only about 1 cm.
4. **Camera.** The native follow camera targets 20 units (2.0 m) × heightScale (E10). Our orbit camera
   uses Babylon's default FOV of 0.8 rad at a radius of 22. A wider or higher camera makes the character
   look smaller against buildings. Matching the native camera distance and FOV is **[unknown]** and out of
   scope here.

## Recommendation

- **Default player scale = 1.00** (h = 2, byte `0x22`). This is the untouched-slider value captured from
  the original client (E5), and the RE'd formula maps it to 1.00 (E6 to E8). Do not change the converter's
  0.1 m-per-unit metric.
- **Implement the Height choice** with factors `[0.94, 0.97, 1.00, 1.03, 1.06]`.
  - Apply it as a uniform scale on the character root, so equipment and weapons scale with it.
  - Apply it to the follow-camera target height as well.
  - Decode it from the low nibble of the Scale byte.
- **Implement Volume later** as the radial per-bone skin factors from E9, never as a uniform scale.
- **For the viewer's demo player, use h = 4 (factor 1.06)** now. The user asked for "a tad bit taller",
  and E12 measured 1.07 ± 0.05.
  - Make it a single constant or URL parameter (for example `?height=0..4`), so the lead can compare.
  - Re-judge only after the navmesh fix lands, because the sunk-in-plaza effect dominated.
- Do not go above 1.06. No evidence supports a larger factor, and openroad's `1 + byte/255` is an
  admitted placeholder.
