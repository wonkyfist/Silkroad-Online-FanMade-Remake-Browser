# Weapon rarity: Seal of Star, Moon and Sun

**Status (2026-10-06):** built; looks redone (v2, §5). Server (drops, notice, GM, admin knobs), client (material look, motes, trail, drop beam,
chimes, tooltip, slot frame, ground label, notice banner), converter (weapon seals of every degree) and tests. Preview
images: `Dropbox/Other Projects/Silkroad Online/rarity-preview/`.

The user's ask: "add rarity to weapons. A weapon without a, b, c is a regular weapon; the moment it is using _a, _b, _c
for retail those are rare weapons. The rare weapons need their own effects and rarity effects and designs to make it
look unique."

**Tags.** [confirmed] checked in the data or the code (the section says how); [decision] a choice this spec makes.

## 1. What retail has

- **The grades are not the rarity.** [confirmed: `work/out/data/items.json`] `ITEM_CH_SWORD_03_A`, `_B`, `_C` are the
  three ordinary grades of a family (Bloody / Deadly / Spiritual Sharp Sword, levels 16 / 18 / 21). The rare rows are
  the **seal** rows `ITEM_CH_SWORD_03_A_RARE`, `_B_RARE`, `_C_RARE`: on a seal row the letter is the seal, not a
  grade (`apps/server/src/uniques.ts` H11-NL-1). "A weapon with _a/_b/_c for retail" in the ask is these rows.
- **Seal of Star / Moon / Sun.** A = Star, B = Moon, C = Sun (retail order; Sun is the top). All three of a family take
  the A grade's level and a short family name ("Sharp Sword").
- **Stats.** [confirmed: all five Chinese weapon kinds, degree 3] Star = the C grade's stats with +1 critical; Moon
  ×1.30 attack, ×1.15 hit, ×1.04 durability, ×1.16 per plus, +2 critical; Sun ×1.65 attack, ×1.30 hit, ×1.08
  durability, ×1.37 per plus, +3 critical. Prices ×1 / ×2.05 / ×3.48 of the C grade. The rows carry all of it, so we
  use them as they are.
- **Which exist.** [confirmed: `Media.pk2 itemdata_5000.txt`] every Chinese weapon family of every degree has its three
  seal rows in service (`ITEM_CH_SWORD_01_A_RARE` ... `_11_`), plus armour, shields and accessories. Our export had only the
  degree-3 ones (the unique's Seal of Star drop, wave 11).
- **Models.** [confirmed: itemdata col 52/54] a seal names the **same** BSR and icon as its ordinary rows
  (`item\china\weapon\sword_03.bsr`); only the ground model differs (`item\etc\drop_ch_equip_rare.bsr`, a gold chest;
  already converted). There is no distinct retail model, so every tier is made unique by treatment (§5).
- **Equipment manifest.** [confirmed] it has no `_RARE` rows: a worn seal was not drawn at all before this. The client
  now draws a seal with its family's `_A` model (`modelCodeOf`).

## 2. Data

- [decision] The converter exports the **weapon** seals of every exported degree (1–4: 60 rows); other seals of degrees
  3 and 4 only (`RARE_ITEM_DEGREES`, `packages/convert/src/data/items.ts isExportedItem`). Drop tables still skip every seal.
  *(2026-10-11, docs/CLIMB.md §4.1.2, D53)* degree 4 is exported (306 rows: 153 regular, 153 seals) and is the Climb's cap
  tier: the Moon/Sun rule of `RARE_TOP_MIN_LEVEL` applies to the top degree (`Rarity.topDegree`, the catalog's highest
  weapon degree), degrees 1–3 roll at §4.2's rates everywhere; a seal's required level is its letter's grade level
  (Star A, Moon B, Sun C) after the Climb's re-spacing.
  *(D54)* At load the degree-3 seals are capped under their family's degree-4 Star (docs/CLIMB.md §4.1.3,
  `applyClimbSealCaps`); degree-3 Moon and Sun come only from level-21+ monsters (`RARE_MID_MIN_LEVEL`). The rates are
  now **Star 1.5 %, Moon 0.4 %, Sun 0.1 %** of a gear drop (§4.2's 4 / 1 / 0.25 replaced), each at most 2 %
  (`RARE_PCT_MAX`), and Tiger Girl's seal groups use the same rates per gear drop.
  The regenerated `items.json` was diffed against the old one: 30 rows added, 0 changed, 0 removed; every other export
  file identical. Re-run `pnpm tsx packages/convert/src/tools/export-data.ts` (or copy items.json) on the deploy machine.
- `packages/shared/src/rarity.ts`: `rarityOf(code)` (`'star' | 'moon' | 'sun' | null`), `rarityRank`, `rarityFamily`,
  `rareCodeOf(code, tier)`, `modelCodeOf`, `RARITY` (names and colours), `RARITY_DEFAULTS`, `rollRarity`.
- A seal is an ordinary item everywhere: stacks, trade, stall, storage, repair, durability and alchemy treat it as a
  weapon (its own row's numbers). +1…+7 (and on) works on it like any weapon [confirmed: `rarity.test.ts`].

## 3. Tiers

| Tier | Code | Rank | Name colour [decision] | Metal | Pattern | Motes | Trail | Beam |
|---|---|---|---|---|---|---|---|---|
| regular | `_A/_B/_C` | 0 | white (+N: gold) | retail | — | — | retail | none |
| Seal of Star | `_A_RARE` | 1 | violet `#b98cff` | violet starsteel | glints twinkling in the texture | 4-point star sparkles | violet, ×1.2 long, additive | 2.6 m violet |
| Seal of Moon | `_B_RARE` | 2 | jade `#6ff0cf` | jade moonsilver | mist flowing up the blade | soft mist rising | jade, ×1.35, additive | 3.4 m jade |
| Seal of Sun | `_C_RARE` | 3 | gold `#ffb02e` | sun gold | rune bands climbing, heat pulse | embers flying up | gold ribbon, ×1.5, alpha | 4.8 m gold |

## 4. Server

### 4.1 Where seals come from [decision]

An ordinary weapon a monster's normal table drops is rolled once: below `RARE_SUN_PCT` it comes as its family's Seal of
Sun row, below Sun + `RARE_MOON_PCT` Moon, below that + `RARE_STAR_PCT` Star (the rarest first: the tiers never
overlap). Count and plus stay; a family without the rolled row stays regular. Uniques, the Ice Yeti and siege monsters
keep their own loot (the unique's 20 % Seal of Star stays). `apps/server/src/rarity.ts rollRareDrops`, called in
`Gameplay.mobDied` around `rollDrops`.

### 4.2 Rates [decision]

| Knob (env, admin panel group "Rare weapons", live) | Default | Range |
|---|---|---|
| `RARE_STAR_PCT` Seal of Star, % of weapon drops | 4 | 0–100 |
| `RARE_MOON_PCT` Seal of Moon | 1 | 0–100 |
| `RARE_SUN_PCT` Seal of Sun | 0.25 | 0–100 |
| `RARE_ANNOUNCE_FROM` announce from rank (1 Star, 2 Moon, 3 Sun, 0 off) | 3 | 0–3 |

About one weapon drop in 25 is a Star, one in 100 a Moon, one in 400 a Sun. `DROP_RATE` already scales how many weapons
drop, so it is not applied twice.

### 4.3 The notice

A seal of rank `RARE_ANNOUNCE_FROM` and up that lands for a loot owner sends `rareNotice { by, item, name, tier }` to
every player in the world (docs/PROTOCOL.md "Rare weapons") and logs the line. The client shows a banner on the notice
queue ("RARE WEAPON — Mei found a Seal of Sun weapon: Sharp Sword!", the name in the tier colour, 7 s) and a chat line in
the notice channel.

### 4.4 Abuse [confirmed: `apps/server/test/rarity.test.ts`]

The tier is decided on the server when the loot is rolled. No request names a new code: alchemy, the GM `plus`, repair,
trade and stalls keep the item's code; a shop refuses a seal it does not sell; a seal is never a starter weapon.

## 5. Looks (client), v2

v1 (a tinted blade, motes, a coloured trail, a column) was rejected: "not just a glowing color, that's boring". v2 was
built with the dream-loop method against approved target images (`rarity-preview/concept/`: `star|moon|sun-target.png` for the sword, `<kind>-<tier>-target.png` for blade, spear, glaive, bow and shield) and judged against them; the
comparison sheets are `rarity-preview/v2/<kind>.png` (regular / Star / Moon / Sun × idle, swing, crit, kill, drop).
All of it on WebGPU and WebGL2, nothing allocated per frame once warm.

### 5.1 Every weapon its own rarity

`world/rarity/kinds.ts`: the kind comes from the slot (shield) or the wearer's weapon family (`rareKindOf`; from a code:
`rareKindOfCode`). Each (tier, kind) has a profile (`rareProfile`): how a swing draws, its reach, how long it lingers,
how many particles, where the emblem sits. Each tier is a clear step up (reach, linger, particles).

| Kind | Swing | Emblem |
|---|---|---|
| sword, blade | a ribbon that follows the blade (smoothed), lingering | on the back |
| spear | a lance shot forward from the tip (Moon: a spiral of crescent rings) | on the back |
| glaive | a wide arc past the tip and a ring of the tier racing round the wearer on the ground | on the back |
| bow | the arrow flies as a shooting star / moon-bolt / sunfire comet | on the back |
| shield | none (it carries the tier's emblem on both faces: a constellation, the crescent, the sun-disc) | on the shield |

### 5.2 The art

Generated (image generation, emissive on black; sources under `rarity-preview/concept/textures/`), packed by
`packages/texpipe/src/rarity-atlas.ts` into `apps/game/public/rarity/`: `fx-atlas.jpg` (2048×2560: the sun-disc mandala,
the filigree crescent, three swing strips, a light pillar, flame, starburst, solar flare, god rays, crescent shockwave,
moonlit ripples, scorched ground, mist, shooting star, flare, orb, ember, smoke; layout `world/rarity/atlas.ts`),
`blade-nebula.jpg` (seamless) and `blade-masks.png` (R constellation lines, G fire cracks, B moonstone, A sheen).
Re-run: `pnpm tsx packages/texpipe/src/rarity-atlas.ts "<Dropbox>/rarity-preview/concept/textures"`.

### 5.3 The blade (three/weapon-rarity.ts)

Plugin `SroRarity` (priority 310, after the +N glow), per-mesh defines on the shared glTF material, per-draw uniforms,
the blade frame (along ai_start → ai_end, across its widest side, its face normal: `bladeFrame`).
- **Star**: near-black glass with deep space inside: two nebula layers at different depths shift with the view
  (parallax), twinkling stars, etched constellation lines that breathe, a white-violet edge.
- **Moon**: pale moonstone: soft inner light, a blue adularescent sheen, a band of light flowing up the blade, silver
  edges; stronger at night (`nightOf(exposure)`).
- **Sun**: dark-gold metal under flowing molten fire cracks and a white-hot core, pulsing with heat.
- The equip flare: your own new seal flares the blade for 1.6 s.
- Low (Classic): `SRORARE_LITE` (tint, steady rim, the tier texture on the item's UVs, a slow pulse).

### 5.4 Around the weapon (world/rarity/fx.ts)

One draw for everything (`world/rarity/batch.ts`: a pooled quad buffer, premultiplied, display colours divided by the
exposure), fixed particle pools (`paint.ts`), two pooled point lights (`world/fx/hit-light.ts`: crit/kill flashes and
your own Sun/Moon weapon's flicker; clustered on PBR).
- **Aura**: Star orbiting stars and a dense trail of twinkling stardust (more the faster the blade moves); Moon silver
  mist pouring off, the crescent halo behind the shoulder, moonlit ripples at the feet and a moonbeam at night; Sun
  flames licking off, rising embers (a rain while swinging), the turning sun-disc behind the back, a warm pool of light
  and scorched glowing ground. Every blade wears a soft sheath of its tier's light.
- **Swing** (§5.1), only the fast part of a swing draws (blade-tip speed ≥ 2.2 m/s).
- **Crit**: Star shooting stars falling onto the target and a starburst; Moon a crescent shockwave over the ground and a
  crescent flash; Sun a solar flare, god rays and flung embers. **Kill**: bigger, plus the constellation around the victim
  / a rising crescent / a sunburst that scorches the ground for 2 s.
- **Drop** (`world/rarity-beam.ts` hands it to the layer): Star a constellation draws itself above the drop and falls onto it
  as a shooting star; Moon a moonbeam comes down from the sky with a crescent shockwave; Sun a pillar of sunfire with a
  solar flare, god rays and the sun-disc opening on the ground. A drop found lying there shows only its standing mark.
- The +N glow keeps the seal's hue (`GlowItemSpec.tint`); the retail trail stays under the seal's ribbon.

### 5.5 Performance [measured]

LOD (`lodOf`): your own weapon full; others full within 18 m up to the preset's cap (Medium 6, High 10, Ultra 14), the
next 2× cap mid (blade sheath, ribbon, motes) within 30 m, the rest only their blade material; Classic your own only.
Bench (headless Chrome, WebGPU, High, 100 players in the plaza, 20 Seal of Sun, own Sun sword; lab harness
`debug/rarity-lab.ts` + `charbench`): the effects layer costs 0.3–0.5 ms CPU and 1 draw call (130–460 quads); frame
p50 with it on / off: close 41.2 / 40.2 (then 36.1), mid 26.8 / 28.6 (then 26.4) ms: within run-to-run noise. The frame
itself (≈26–41 ms there) is the 100 characters (docs/CHAR_PERF work), not the rare effects.

### 5.6 HUD

Unchanged from v1: the name in the tier colour with its banner, the slot frame and shine, the ground label, the notice.

### 5.7 Lab

`?rarelab=1` installs `window.__sroRareLab` (`debug/rarity-lab.ts`): framing, held poses, `swingShot`,
`moment('crit'|'kill'|'equip')`, `drop(tier)`, `arrow()`, `freeze()`, `fx(on)` and `stats()` (counts, quads, CPU ms).

### 5.8 Round 3

- **Solid weapons** [confirmed]: retail weapon and shield textures (sword1_2_3, spear_1_5, tblade_1_5, bow_1_5, Shield_04)
  carry a specular/env mask in their alpha (79-94 % partial). The converter exported them BLEND and the equipment set
  alpha-tested spear_03 and bow_03 at 128, so their heads drew as outlines (the actor texture swap also turned BLEND into
  an alpha test). The converter now exports weapon/shield partial alpha OPAQUE (`gltf/convert.ts isWeaponPath`;
  re-run `export-equipment` and the optimizer to refresh `equipment/` and `out-opt/`), and `three/weapon-solid.ts`
  applies the same rule at load to glbs converted before (binary cut-outs and effect cards keep their alpha).
- **Blade shells** (`fx.ts bladeHalo`): Star a drifting nebula strip, constellation lines and a violet core over every
  blade, head and shaft (sized for the camera distance), more and brighter orbiting stars and an idle stardust drift;
  Sun a heat bloom, gold body, white-hot core and flames licking off both edges; spear and glaive shafts carry a band.
- **Spear lances** (`fx.ts thrust`, fired on the hit of every attack and skill, `features/rarity.ts`): Star a comet
  of stardust with a starburst, Moon a silver lance ringed by spiralling crescents, Sun a widening flame cone with a
  white-hot core, an ember blast and a scorch line.
### 5.9 On the weapon only, from its own geometry

- **Scope** [decision, user]: no emblems behind the wearer (the sun-disc, the crescent halo), no night moonbeam, and
  nothing on the floor while wielding (scorch, ripples, the glaive's ground ring, the equip ring). Everything is on the
  weapon; crits, kills, lances and drops keep their moments. The atlas cells stay (drops, shields and bursts use them).
- **Alignment** [confirmed]: the effect frame came from the ai_start/ai_end line and the whole item's box (a glaive's
  line runs beside its blade; a spear's box includes its tassel), so shells and flames sat off the blade.
  `world/rarity/region.ts weaponRegion` derives it from the model's vertices once per geometry and kind (cached): the
  long axis, per-bin width and centre line, then the blade (guard to tip), the head (spears, glaives: from the tip back
  while wider than the shaft) or the whole (bows). Every emitter, shell, ribbon and lance origin uses it in the weapon's
  own space, so it follows every pose. `packages/convert/test/weapon-region.test.ts` checks all 20 Chinese weapon glbs
  of the equipment set (degrees 1-4): base, tip and region box inside the model, the region ending at the tip, spear and
  glaive regions on the head with the shaft below. Contact sheet: `rarity-preview/v3/align.png`.
- **Fire and mist**: no upright flame strips; the Sun fire is many small soft camera-facing puffs from points on the
  blade's surface (varied size, turn, life, curl; white-hot cores among them), the Moon mist soft puffs that curl.

### 5.10 No white wash; shields on their own mesh

- **Root cause of the white overlay** [confirmed by bisecting the shader terms on ITEM_CH_BOW_04_A_RARE]: the blade
  shader's "edge" term was |offset across the blade| / half width, which is above 1 over most of a curved or wide
  model (bow limbs, shield plates, a dao's belly), so the pale accent colour was added over the whole weapon; the
  additive glow shells along the blade added more. Removed the edge term and the shells; the accents are tier colours;
  the silhouette glow is only the fresnel rim in the tier's colour.
- **Shields**: no added model. The tier material goes on the shield's own mesh at full strength (its region is the
  whole plate); light particles around it. shield-face.ts and its textures are deleted.

## 6. GM

- `/item ITEM_CH_SWORD_03_C_RARE` gives any seal.
- `/rarity` (or `/rarity rates`): the live rates and the announce rank.
- `/rarity give <star|moon|sun> [weapon code]`: the seal of that weapon (default: your worn weapon's family) into your bag.
- `/rarity drop <star|moon|sun> [weapon code]`: drops one at your feet, owned by you, with the notice from its rank.
- `/plus weapon 7` on a seal: the glow in the seal's hue.

## 7. Tests

- `packages/shared/test/rarity.test.ts`: tier parsing, family and seal codes, model codes, the one-roll draw and its
  default rates, `rareNotice` on the wire.
- `apps/server/test/rarity.test.ts`: the drop roll (only ordinary weapons with a seal row), env knobs and the admin
  rows, kills with live rates and the notice rank, alchemy on a seal, the abuse rules, the GM command.
- `apps/game/test/rarity-fx.test.ts` (v2): per-kind selection and profiles, LOD, the atlas, the batch, particles, the
  effects layer (swings, crits, kills, arrows, equip flare, drops).
- `apps/game/test/weapon-rarity.test.ts`: the looks, the plugin code in both languages and on a NullEngine material,
  values, motes (caps, order, Low), the actor plumbing, trail, beam, chimes, tooltip, slot signs, the notice text.
- `packages/convert/test/data-rare.test.ts`, `data-builders.test.ts`: the weapon seals of every degree are exported.
