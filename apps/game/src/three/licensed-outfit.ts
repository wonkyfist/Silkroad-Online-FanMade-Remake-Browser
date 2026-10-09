// Outfits from gear (docs/CHARACTERS.md §16.9): on the licensed Waterbender bodies the worn armour decides the look.
// The pure part: which pack pieces a worn item shows (by armour class and slot), which body slices they hide, and the
// cloth's colours (by class, degree, grade) and effects (degree, seal). The Babylon part (materials, the per-outfit
// colour bake, applying it to a body) is three/licensed-cloth.ts. Stats, levels and sources of the items are untouched:
// only the drawing reads the item codes the client already receives (EntityState.equip / appearance.equip).
import type { EquipSlot, JobBadge, RarityTier } from '@sro/shared'
import { rarityOf } from '@sro/shared'
import { jobClothFx, jobDyeOf, jobKey, jobPaletteRow, type JobDye } from './job-look.ts'

/** Silkroad's armour classes: garment (CLOTHES), protector (LIGHT), armour (HEAVY). */
export type ArmourClass = 'garment' | 'protector' | 'armour'
export const ARMOUR_CLASSES: readonly ArmourClass[] = ['garment', 'protector', 'armour']
const CLASS_TOKEN: Readonly<Record<string, ArmourClass>> = { CLOTHES: 'garment', LIGHT: 'protector', HEAVY: 'armour' }
/** The item code's part letters → its slot (retail: HA head, SA shoulders, BA body, LA legs, AA arms, FA feet). */
const PART_SLOT: Readonly<Record<string, EquipSlot>> = { HA: 'head', SA: 'shoulders', BA: 'chest', LA: 'legs', AA: 'hands', FA: 'feet' }
export type Grade = 'A' | 'B' | 'C'

/** One worn armour item as the look reads it. */
export interface GearPiece {
  slot: EquipSlot
  cls: ArmourClass
  /** The item's degree (1..; the palette rows stop at 4). */
  degree: number
  grade: Grade
  seal: RarityTier | null
  /** In job mode (docs/JOBS.md §3.3): the job's palette, trim and twill over the item's (three/job-look.ts). */
  job?: JobDye
}

// `_DEF`: the starter set every new character wears (the plain row's model and look). Unparsed, a licensed body drew
// the lingerie for it; in job mode the suit's plain fill hid that, so the gear seemed to vanish when the suit came off
// (docs/JOBS.md "Polish status").
const ARMOUR_RE = /^ITEM_(?:CH|EU)_[MW]_(CLOTHES|LIGHT|HEAVY)_(\d\d)_([A-Z]{2})_([ABC])(?:_DEF)?(?:_RARE)?$/

/** An armour code as the look reads it (`ITEM_CH_W_HEAVY_03_BA_B_RARE` → chest, armour, D3, B, moon); null otherwise. */
export function gearOf(code: string | null | undefined, slot?: EquipSlot): GearPiece | null {
  if (!code) return null
  const m = ARMOUR_RE.exec(code)
  if (!m) return null
  const s = slot ?? PART_SLOT[m[3]!]
  if (!s) return null
  return { slot: s, cls: CLASS_TOKEN[m[1]!]!, degree: Math.max(1, Number(m[2])), grade: m[4] as Grade, seal: rarityOf(code) }
}

// ---- pieces ----------------------------------------------------------------------------------------------------------

/**
 * The pack's separated pieces (waterbender-export.py piece keys). BELT_CUT is the girl's belt cut for a body without the
 * skirt; LINGERIE_* are drawn where no chest / legs piece is worn.
 */
export type PieceKey =
  | 'TOP' | 'SLEEVES' | 'LAYERING' | 'FRONT_CLOTH' | 'SKIRT' | 'TAILS' | 'PANTS' | 'CHAPS' | 'GLOVES' | 'SHOES'
  | 'BELT' | 'BELT_CUT' | 'ROPE' | 'FLOWERS' | 'LINGERIE_TOP' | 'LINGERIE_BOTTOM'

/** The armour slots the pieces stand for (the earring: the girl's EARRINGS part, Outfit.earring; head, necklace, rings: nothing yet). */
export type OutfitSlot = 'chest' | 'legs' | 'hands' | 'feet' | 'shoulders'
export const OUTFIT_SLOTS: readonly OutfitSlot[] = ['chest', 'legs', 'hands', 'feet', 'shoulders']

/**
 * Slot × class → pieces (the user's design, §16.9): garment = top + pants + shoes; protector adds layering, front
 * cloth, gloves, chaps; armour adds skirt, tails, belt, rope. Shoulders wear the sleeves (+ tails for armour); the belt,
 * its rope and its flowers come with an armour chest. A garment's gloves draw nothing (bare hands).
 */
export const SLOT_PIECES: Readonly<Record<OutfitSlot, Readonly<Record<ArmourClass, readonly PieceKey[]>>>> = {
  chest: { garment: ['TOP'], protector: ['TOP', 'LAYERING', 'FRONT_CLOTH'], armour: ['TOP', 'LAYERING', 'FRONT_CLOTH', 'BELT', 'ROPE', 'FLOWERS'] },
  legs: { garment: ['PANTS'], protector: ['PANTS', 'CHAPS'], armour: ['PANTS', 'CHAPS', 'SKIRT'] },
  hands: { garment: [], protector: ['GLOVES'], armour: ['GLOVES'] },
  feet: { garment: ['SHOES'], protector: ['SHOES'], armour: ['SHOES'] },
  shoulders: { garment: ['SLEEVES'], protector: ['SLEEVES'], armour: ['SLEEVES', 'TAILS'] },
}

/** One piece drawn and the item it shows (its colours and effects). */
export interface OutfitPiece {
  piece: PieceKey
  gear: GearPiece
}

/** What a body wears (outfitFromGear): the pieces drawn, each with its item. */
export interface Outfit {
  gender: 'f' | 'm'
  pieces: OutfitPiece[]
  /**
   * The worn earring (the girl's pack EARRINGS part, shown while one is worn; coloured by its degree with the chest's
   * class palette, a seal adds a sparkle). The boy's pack has no earring mesh: null for him.
   */
  earring?: GearPiece | null
}

const EARRING_RE = /^ITEM_(?:CH|EU)_EARRING_(\d\d)_([ABC])(?:_RARE)?$/

/** An earring code as the look reads it (degree, grade, seal), its palette class `cls` (the chest's); null otherwise. */
export function earringOf(code: string | null | undefined, cls: ArmourClass = 'armour'): GearPiece | null {
  if (!code) return null
  const m = EARRING_RE.exec(code)
  if (!m) return null
  return { slot: 'earring', cls, degree: Math.max(1, Number(m[1])), grade: m[2] as Grade, seal: rarityOf(code) }
}

/**
 * The outfit of `equip` (EntityState.equip: slot → item code) on body `gender`. Missing slots draw nothing (the bare
 * body slice, the lingerie where chest / legs are empty); a slot with a non-armour code (a costume, an unknown row) too.
 * Mixed classes and degrees work per slot. `job` (EntityState.job, job mode): every piece takes the job's colours
 * (JOBS.md §3.3); a missing chest, legs or feet is filled with plain garment cloth then (a suit is never the
 * lingerie).
 */
export function outfitFromGear(equip: Partial<Record<EquipSlot, string>> | null | undefined, gender: 'f' | 'm', job?: JobBadge | null): Outfit {
  const dye = jobDyeOf(job)
  const pieces: OutfitPiece[] = []
  const bySlot = new Map<OutfitSlot, GearPiece>()
  for (const slot of OUTFIT_SLOTS) {
    const g = gearOf(equip?.[slot], slot) ?? (dye && JOB_FILL.includes(slot) ? { ...JOB_PLAIN, slot } : null)
    if (g) bySlot.set(slot, dye ? { ...g, job: dye } : g)
  }
  const skirt = bySlot.get('legs')?.cls === 'armour'
  for (const [slot, gear] of bySlot) {
    for (const p of SLOT_PIECES[slot][gear.cls]) {
      // the girl's full belt sits on the skirt's waistband; without the skirt she wears the cut one
      const piece: PieceKey = p === 'BELT' && gender === 'f' && !skirt ? 'BELT_CUT' : p
      pieces.push({ piece, gear })
    }
  }
  if (!bySlot.has('chest') && gender === 'f') pieces.push({ piece: 'LINGERIE_TOP', gear: UNDERWEAR })
  if (!bySlot.has('legs')) pieces.push({ piece: 'LINGERIE_BOTTOM', gear: UNDERWEAR })
  const earring = gender === 'f' ? earringOf(equip?.earring, bySlot.get('chest')?.cls) : null
  return earring ? { gender, pieces, earring } : { gender, pieces }
}

/** The plain cloth a job suit fills an empty chest, legs or feet with (garment D1, then dyed by the job). */
const JOB_FILL: readonly OutfitSlot[] = ['chest', 'legs', 'feet']
const JOB_PLAIN: GearPiece = { slot: 'chest', cls: 'garment', degree: 1, grade: 'A', seal: null }

/** The lingerie's stand-in item (its own flat material; never recoloured). */
const UNDERWEAR: GearPiece = { slot: 'chest', cls: 'garment', degree: 1, grade: 'A', seal: null }

/** A short key of what the outfit draws (pieces + their palettes): bodies with the same key share the colour bake. */
export function outfitKey(o: Outfit): string {
  const k = o.pieces
    .map(p => `${p.piece}=${paletteKey(p.gear)}`)
    .sort()
    .join(',')
  return o.earring ? `${k},EARRINGS=${paletteKey(o.earring)}` : k
}

/** The seal tiers an outfit shows (its pieces' and the earring's), for the hem particles (three/licensed-cloth-fx.ts). */
export function outfitSeals(o: Outfit): RarityTier[] {
  const s = new Set<RarityTier>()
  for (const p of o.pieces) if (p.gear.seal) s.add(p.gear.seal)
  return [...s]
}

// ---- wear: dirt and blood (§16.9) ---------------------------------------------------------------------------------------

/** Dirt and blood on the cloth, each in WEAR_LEVELS steps (0 clean): a few discrete levels so the materials stay shared. */
export interface ClothWear {
  dirt: number
  blood: number
}
export const WEAR_LEVELS = 3
export const CLEAN: ClothWear = { dirt: 0, blood: 0 }
export function wearKey(w: ClothWear | null | undefined): string {
  return w && (w.dirt > 0 || w.blood > 0) ? `w${w.dirt}${w.blood}` : ''
}

// ---- body slices -------------------------------------------------------------------------------------------------------

/**
 * The sidecar's coverage (`licensed.wardrobe`, waterbender-export.py): its pieces in bit order and, per body slice, its
 * vertices grouped by the pieces covering them ([mask, count]).
 */
export interface WardrobeCoverage {
  pieces: readonly string[]
  slices: Readonly<Record<string, readonly (readonly [number, number])[]>>
  /**
   * The slices were cut by coverage (packages/convert/src/tools/licensed/body-slices.ts: `BODY_PART_04_S2`, every
   * triangle of a sub-slice is covered by the same outfits): a sub-slice goes only when the worn pieces cover ALL of
   * it, so no skin is ever missing between pieces (the ankle between loose pants and short boots). Without it (an
   * older build) the share thresholds below decide per whole slice.
   */
  exact?: boolean
}

/** A body part's slice key without its sub-slice (`BODY_PART_04_S2` → `BODY_PART_04`). */
export function sliceBase(key: string): string {
  return key.replace(/_S\d+$/, '')
}

/** The piece / slice a part of the body is (its node name without the LOD and primitive suffixes); null: a fixed part. */
export function partKeyOf(name: string): string | null {
  const base = name.replace(/_primitive\d+$/, '').replace(/__LOD\d$/, '')
  if (/LINGERIE/.test(base)) return /_BRA$/.test(base) ? 'LINGERIE_TOP' : 'LINGERIE_BOTTOM'
  const m = /_(BODY_PART_\d\d(?:_S\d+)?|TOP|SLEEVES|LAYERING|FRONT_CLOTH|SKIRT|TAILS|PANTS|CHAPS|GLOVES|SHOES|BELT(?:_cut)?|ROPE|FLOWERS)$/i.exec(base)
  return m ? m[1]!.toUpperCase() : null
}

/**
 * Every set of pieces a body of `gender` can wear (each outfit slot empty or of each class, the lingerie where chest /
 * legs are empty; a job suit's fill draws garment pieces, already among them): the converter cuts the slices so that
 * each of these hides whole sub-slices only.
 */
export function wearablePieceSets(gender: 'f' | 'm'): string[][] {
  const opts: (ArmourClass | null)[] = [null, ...ARMOUR_CLASSES]
  const part: Record<OutfitSlot, string> = { chest: 'BA', legs: 'LA', hands: 'AA', feet: 'FA', shoulders: 'SA' }
  const tok: Record<ArmourClass, string> = { garment: 'CLOTHES', protector: 'LIGHT', armour: 'HEAVY' }
  const seen = new Map<string, string[]>()
  const walk = (i: number, equip: Partial<Record<EquipSlot, string>>): void => {
    if (i === OUTFIT_SLOTS.length) {
      const set = [...new Set(outfitFromGear(equip, gender).pieces.map(p => p.piece))].sort()
      seen.set(set.join(','), set)
      return
    }
    const slot = OUTFIT_SLOTS[i]!
    for (const c of opts) walk(i + 1, c ? { ...equip, [slot]: `ITEM_CH_${gender === 'f' ? 'W' : 'M'}_${tok[c]}_01_${part[slot]}_A` } : equip)
  }
  walk(0, {})
  return [...seen.values()]
}

/** A slice is hidden when the worn pieces cover at least this share of its vertices (the artist's own hid 0.95). */
export const SLICE_HIDE_AT = 0.945
/** Slices never hidden: the neck under a collar and the hands (the pack's own outfits always show them). */
/**
 * The legs under loose pants: the baggy pants hang more than 15 cm off the skin in places (the coverage rays miss
 * there) and the leg showed through the seat; the slice goes once the pants and shoes cover this much.
 */
export const SLICE_HIDE_LOW: Readonly<Record<'f' | 'm', Readonly<Record<string, number>>>> = { f: { BODY_PART_04: 0.7 }, m: { BODY_PART_03: 0.7 } }
export const SLICE_KEEP: Readonly<Record<'f' | 'm', readonly string[]>> = { f: ['BODY_PART_01', 'BODY_PART_05'], m: ['BODY_PART_02', 'BODY_PART_05'] }

/** The share of each slice's vertices the worn pieces cover. */
export function sliceCover(cov: WardrobeCoverage, worn: Iterable<string>): Map<string, number> {
  let mask = 0
  for (const p of worn) {
    const i = cov.pieces.indexOf(p)
    if (i >= 0 && i < 31) mask |= 1 << i
  }
  const out = new Map<string, number>()
  for (const [slice, rows] of Object.entries(cov.slices)) {
    let tot = 0
    let hit = 0
    for (const [m, n] of rows) {
      tot += n
      if (m & mask) hit += n
    }
    out.set(slice, tot ? hit / tot : 0)
  }
  return out
}

/**
 * The body slices the outfit hides, never the neck or the hands. Cut slices (`exact`): a sub-slice the worn pieces
 * cover entirely (skin is never missing between pieces). Older builds: covered ≥ SLICE_HIDE_AT (SLICE_HIDE_LOW).
 */
export function hiddenSlices(o: Outfit, cov: WardrobeCoverage | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!cov) return out
  for (const [slice, share] of sliceCover(cov, o.pieces.map(p => p.piece))) {
    const base = sliceBase(slice)
    if (SLICE_KEEP[o.gender].includes(base)) continue
    if (cov.exact ? share >= 1 : share >= (SLICE_HIDE_LOW[o.gender][slice] ?? SLICE_HIDE_AT)) out.add(slice)
  }
  return out
}

// ---- colours ------------------------------------------------------------------------------------------------------------

/**
 * The cloth's colour regions (the pack's Clothes MatID map, grouped by the converter, licensed/cloth-dye.ts): the
 * dye map's R G B are the weights of MAIN, SECOND, TRIM, the shade map's G the LEATHER weight; LIGHT is the rest.
 * - MAIN: the outer cloth (skirt panels, the top's front), SECOND: the darker cloth (pants, corset, gloves, sash),
 * - TRIM: borders, embroidery, thread, the flowers and the metal fittings, LEATHER: belts, boots, chaps' straps,
 * - LIGHT: the undershirt, the front cloth's linen panels.
 */
export const DYE_REGIONS = ['main', 'second', 'trim', 'leather', 'light'] as const
export type DyeRegion = (typeof DYE_REGIONS)[number]
/** The dye map's linear grey: a texel at its region's mean brightness (the bake and the shader scale by 1 / this). */
export const DYE_SHADE_MID = 0.25

/** sRGB hex per region. */
export type PaletteRow = Readonly<Record<DyeRegion, string>>

/**
 * The palette table (data, §16.9): per class and degree. D1 plain undyed cloth, D2 dyed colours, D3 rich colours with
 * trim, D4 deep colours with gold / silver trim. The classes read apart at every degree: garment soft and light (linen,
 * indigo, teal, midnight with silver), protector earthy and leathery (hemp, forest, jade with bronze, emerald with gold),
 * armour dark and heavy (wool and iron, umber, crimson with brass, imperial plum with gold).
 */
export const PALETTES: Readonly<Record<ArmourClass, readonly PaletteRow[]>> = {
  garment: [
    { main: '#cbbfa6', second: '#a89c86', trim: '#8a7a64', leather: '#9a7a58', light: '#e6dfcf' },
    { main: '#4a6a9a', second: '#2f3e5c', trim: '#c9b48a', leather: '#7a5a40', light: '#e4e0d6' },
    { main: '#1f7a86', second: '#1d3f52', trim: '#e8d6a6', leather: '#6a4632', light: '#efe8d8' },
    { main: '#1c2c5e', second: '#121a36', trim: '#d8dde6', leather: '#3a2a26', light: '#e8e6ee' },
  ],
  protector: [
    { main: '#a29a84', second: '#857c68', trim: '#6e6354', leather: '#7a5c40', light: '#d8d0bc' },
    { main: '#4f6b3c', second: '#3a4630', trim: '#a88c5a', leather: '#6c4a30', light: '#ddd6c0' },
    { main: '#2e8a68', second: '#24493c', trim: '#c08a48', leather: '#5e3c26', light: '#e6e0cc' },
    { main: '#0f5a46', second: '#0d2e26', trim: '#e2b850', leather: '#3c2618', light: '#ece2c4' },
  ],
  armour: [
    { main: '#7d7468', second: '#5c564e', trim: '#6c6a66', leather: '#5a4434', light: '#bfb6a6' },
    { main: '#8a6430', second: '#4a3a24', trim: '#a08a5a', leather: '#5a3a28', light: '#d6ccb8' },
    { main: '#a01e2a', second: '#3e1a1e', trim: '#d4a64a', leather: '#4a2a1c', light: '#e2d4bc' },
    { main: '#4a1a4a', second: '#1e0e1e', trim: '#f0c860', leather: '#2e1a14', light: '#e8d8c0' },
  ],
}

/** Grade A/B/C: the trim a little richer (saturation and brightness × this). */
export const GRADE_TRIM: Readonly<Record<Grade, number>> = { A: 1, B: 1.08, C: 1.16 }

/** The cloth's effects: silk sheen on the trim (D3+), the woven shimmer (D4), the seal's thread (Star / Moon / Sun). */
export interface ClothFx {
  sheen: number
  weave: number
  seal: 0 | 1 | 2 | 3
  sealAmount: number
}

export const SEAL_CODE: Readonly<Record<RarityTier, 1 | 2 | 3>> = { star: 1, moon: 2, sun: 3 }
/** The seal's strength in the cloth (the mix of its nebula / moonstone / gold into the dyed cloth). */
export const SEAL_AMOUNT: Readonly<Record<RarityTier, number>> = { star: 0.9, moon: 0.85, sun: 0.9 }

/**
 * The far bodies' static seal tint (LOD2 and the crowd: no shader effects there), linear, per region: [colour, mix].
 * Star a deep violet in the dyed cloth, Moon cool moonstone with a silver trim, Sun warm cloth with a gold trim.
 */
export const SEAL_FAR_TINT: Readonly<Record<RarityTier, Partial<Record<DyeRegion, readonly [readonly [number, number, number], number]>>>> = {
  star: { main: [[0.07, 0.03, 0.2], 0.75], second: [[0.035, 0.015, 0.11], 0.7], trim: [[0.45, 0.38, 0.8], 0.35] },
  moon: { main: [[0.16, 0.19, 0.3], 0.55], second: [[0.07, 0.08, 0.13], 0.5], trim: [[0.62, 0.66, 0.74], 0.6], light: [[0.6, 0.64, 0.74], 0.35] },
  sun: { main: [[0.42, 0.13, 0.03], 0.35], second: [[0.16, 0.05, 0.015], 0.3], trim: [[0.95, 0.6, 0.16], 0.7] },
}

/** A piece's far colours: its palette with the seal's static tint (paletteLinear for an unsealed item). */
export function farPaletteLinear(g: GearPiece): Record<DyeRegion, [number, number, number]> {
  const p = paletteLinear(g)
  const tint = g.seal ? SEAL_FAR_TINT[g.seal] : null
  if (!tint) return p
  for (const r of DYE_REGIONS) {
    const t = tint[r]
    if (!t) continue
    const [c, k] = t
    p[r] = p[r].map((v, i) => v + (c[i]! - v) * k) as [number, number, number]
  }
  return p
}

/** The palette row of a degree (1.., clamped to the table). */
export function paletteRowOf(cls: ArmourClass, degree: number): PaletteRow {
  const rows = PALETTES[cls]
  return rows[Math.max(0, Math.min(rows.length - 1, Math.floor(degree) - 1))]!
}

/** The palette's key (class, degree row, grade, seal): one material per key. */
export function paletteKey(g: GearPiece): string {
  const row = Math.max(1, Math.min(PALETTES[g.cls].length, Math.floor(g.degree)))
  return `${g.cls[0]}${row}${g.grade}${g.seal ? `*${SEAL_CODE[g.seal]}` : ''}${jobKey(g.job)}`
}

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const toLinear = (c: number) => Math.pow(c, 2.2)

/** The trim × the grade: saturation and brightness up (in sRGB, clamped). */
export function gradeTrim(rgb: readonly [number, number, number], grade: Grade): [number, number, number] {
  const k = GRADE_TRIM[grade]
  const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  return rgb.map(c => Math.max(0, Math.min(1, (l + (c - l) * k) * (1 + (k - 1) * 0.5)))) as [number, number, number]
}

/** The region colours of a piece's item, linear RGB (what the shader and the bake multiply the shade by). */
export function paletteLinear(g: GearPiece): Record<DyeRegion, [number, number, number]> {
  const row = g.job ? jobPaletteRow(paletteRowOf(g.cls, g.degree), g.job) : paletteRowOf(g.cls, g.degree)
  const out = {} as Record<DyeRegion, [number, number, number]>
  for (const r of DYE_REGIONS) {
    let c = hexRgb(row[r])
    if (r === 'trim') c = gradeTrim(c, g.grade)
    out[r] = c.map(toLinear) as [number, number, number]
  }
  return out
}

/** The cloth effects of a piece's item. */
export function clothFxOf(g: GearPiece): ClothFx {
  const d = Math.floor(g.degree)
  const gradeK = GRADE_TRIM[g.grade] - 1
  const base = { sheen: d >= 3 ? 0.35 + gradeK * 1.5 : 0, weave: d >= 4 ? 0.6 + gradeK * 2 : 0 }
  const { sheen, weave } = g.job ? jobClothFx(base, g.job) : base
  return {
    sheen,
    weave,
    seal: g.seal ? SEAL_CODE[g.seal] : 0,
    sealAmount: g.seal ? SEAL_AMOUNT[g.seal] : 0,
  }
}

// ---- the far bake (LOD2 and the crowd) -------------------------------------------------------------------------------

/**
 * The per-outfit colour bake (pure): `lo` is the converter's small clothes map (RGBA: R the shade, G the region index ×
 * 32, B the owner piece's index in `pieces` + 1, A 255), `colour(piece)` a piece's region colours (linear) or null when
 * the piece is not worn. Writes sRGB RGBA into `out`. A texel of a piece not worn takes the shade in grey (never drawn).
 */
export function bakeOutfit(
  lo: Uint8Array | Uint8ClampedArray,
  pieces: readonly string[],
  colour: (piece: string) => Record<DyeRegion, [number, number, number]> | null,
  out: Uint8Array = new Uint8Array(lo.length),
): Uint8Array {
  const cache = new Map<number, Record<DyeRegion, [number, number, number]> | null>()
  const toS = (v: number) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2))
  for (let i = 0; i < lo.length; i += 4) {
    const shade = Math.pow(lo[i]! / 255, 2.2) / DYE_SHADE_MID
    const region = DYE_REGIONS[Math.min(DYE_REGIONS.length - 1, Math.round(lo[i + 1]! / 32))]!
    const owner = lo[i + 2]!
    let pal = cache.get(owner)
    if (pal === undefined) {
      pal = owner > 0 ? colour(pieces[owner - 1] ?? '') : null
      cache.set(owner, pal)
    }
    const c = pal ? pal[region] : ([0.18, 0.18, 0.18] as [number, number, number])
    out[i] = toS(c[0] * shade)
    out[i + 1] = toS(c[1] * shade)
    out[i + 2] = toS(c[2] * shade)
    out[i + 3] = 255
  }
  return out
}
