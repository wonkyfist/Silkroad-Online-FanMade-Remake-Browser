/**
 * The townsfolk's dressed variants (docs/TOWN_LIFE.md §3.1–§3.3, §4, §9.1; WAVE_PLAN7 §6.1 lane TL-V): which retail
 * bodies, garments and models the crowd is made of, and the dresser that turns each into ONE skinned mesh with ONE
 * material (its textures packed into one atlas, ./atlas.ts), so a variant is one draw for every townsperson wearing it.
 *
 * - People: a retail Chinese body (`work/out/char/china/china{man,woman}_*.glb`) dressed with a retail garment set
 *   (`ITEM_CH_{M,W}_{CLOTHES,LIGHT}_0N_{BA,LA,FA}[,HA][,AA]_A`) by the game's own rules (`@sro/appearance`
 *   composeEquipment: REPLACE hides the base meshes of its slots), the garments' joint indices remapped by joint NAME
 *   onto the body's skin order (the women's feet and legs list their joints in another order). 9 + 9 variants ranked
 *   Medium 5 + 5, High 7 + 7, Ultra 9 + 9 (TOWN_LIFE §3.2, §8.2). They share one VAT per gender (./vat.ts), which the
 *   dresser checks: every part's inverse bind matrices equal the body's.
 * - Guards, elders and animals: retail models drawn as they are (TOWN_LIFE §3.1, §4), converted from the client by the
 *   converter's own BSR path, each merged and atlased the same way, each skeleton with its own VAT (the two guards
 *   share `ch_guard`).
 *
 * Materials as the game's actor path makes them: the retail BMT emissive (0.59 grey on the cos and npc models, which
 * renders pure white when taken as a glTF emissive) is ZEROED in the variant and reported as `selfLit`; the game turns
 * a character's emissive into the ambient-scaled self-lit term (world-render PbrSurfaces.addEmissive through
 * `decorateCharacterMaterial`), so TL-C sets `selfLit` as the material's emissive before decorating it. Double-sided
 * pieces (hair, capes) get a mirrored copy (reversed winding, flipped normals) when the rest is single-sided, so the
 * one material stays back-face culled; a model that is double-sided throughout keeps one double-sided material.
 */
import { createHash } from 'node:crypto'
import { Document, type Material, type Node, type Primitive, type Skin } from '@gltf-transform/core'
import { composeEquipment, type EquipmentManifest } from '@sro/appearance'
import { atlasUv, buildAtlas, decodeImage, encodePng, type AtlasSource, type RgbaImage } from './atlas.ts'

export type TownAssetKind = 'person' | 'guard' | 'elder' | 'animal'
/** The lowest preset that draws a variant (TOWN_LIFE §8.2: Medium 10 people, High 14, Ultra 18). */
export type TownRank = 'medium' | 'high' | 'ultra'
export type TownGender = 'male' | 'female'

/** WAVE_PLAN7 §5.3 TL-V: per variant ≤ 3,000 triangles and one atlas ≤ 1024². */
export const VARIANT_MAX_TRIANGLES = 3000
export const VARIANT_MAX_ATLAS = 1024

/** A clip of a VAT: `anim` in the canonical glb, in another body (`from`), or one of TL-A2's town clips (`town`). */
export interface TownClipSpec {
  /** The clip's key in the VAT (VatFile.clips). */
  name: string
  /** The animation's name in its glb (a town clip's name comes from town_clips.json). */
  anim?: string
  /** Another body glb's basename (a gait style: its STAND1 / WALK). */
  from?: string
  /** A TL-A2 clip kind (TOWN_KINDS: SIT_CHAIR, CARRY, TALK, SWEEP) from `moves/<skel>/town/town_clips.glb`. */
  town?: string
  fps?: number
  loop: boolean
  /** Layer the clip on this one (an overlay clip: joints it does not animate follow the base, vat.ts). */
  base?: string
  /** Skipped with a warning when its source is missing (the town clips before TL-A2's pack exists). */
  optional?: boolean
}

/** A dressed person. */
export interface PersonSpec {
  id: string
  kind: 'person'
  gender: TownGender
  /** The body glb's basename (`work/out/char/china/<body>.glb`). */
  body: string
  /** Equipment manifest item codes it wears. */
  items: string[]
  rank: TownRank
}

/** A retail model drawn as it is. */
export interface ModelSpec {
  id: string
  kind: 'guard' | 'elder' | 'animal'
  /** The client path (Data.pk2) of the model. */
  bsr: string
  clips: TownClipSpec[]
  rank: TownRank
}

/** The bodies whose skins and default clips the two people VATs are built on (merchant gait, TOWN_LIFE §3.2). */
export const PEOPLE_SKELETONS: Record<TownGender, { body: string, skeleton: string }> = {
  male: { body: 'chinaman_merchant', skeleton: 'europeman_skel' },
  female: { body: 'chinawoman_merchant', skeleton: 'europewoman_skel' },
}

/**
 * The people's clips (TOWN_LIFE §3.1, §3.3): the retail set without WAIT01–04 (qigong casting holds, F6) and EMOTION03
 * (rush); EMOTION01/02/04/07 are the chatters' turns; VENDOR01 at 15 fps (a slow 10–13 s loop); the cart pair for
 * porters; HAMMER at the smith's anvil (looped); gait styles as `<clip>@<style>` from the bodies that carry them
 * (merchant is the default; fighter and tattoo for men, fighter for women: the women's other styles are kangsi, a hop,
 * and necromancer); then TL-A2's four town clips.
 */
export function peopleClips(gender: TownGender): TownClipSpec[] {
  const g = gender === 'male' ? 'chinaman' : 'chinawoman'
  const styles = gender === 'male' ? ['fighter', 'tattoo'] : ['fighter']
  return [
    { name: 'STAND1', anim: 'STAND1', loop: true },
    // STAND3 is an upper-body idle (the converter's `partial`, 26 of 37 joints): layered on STAND1 as the game plays it
    { name: 'STAND3', anim: 'STAND3', base: 'STAND1', loop: true },
    { name: 'WALK', anim: 'WALK', loop: true },
    { name: 'RUN', anim: 'RUN', loop: true },
    { name: 'SIT_DOWN', anim: 'SIT_DOWN', loop: false },
    { name: 'SIT', anim: 'SIT', loop: true },
    { name: 'STAND_UP', anim: 'STAND_UP', loop: false },
    { name: 'EMOTION01', anim: 'EMOTION01', loop: false },
    { name: 'EMOTION02', anim: 'EMOTION02', loop: false },
    { name: 'EMOTION04', anim: 'EMOTION04', loop: false },
    { name: 'EMOTION07', anim: 'EMOTION07', loop: false },
    { name: 'VENDOR01', anim: 'VENDOR01', fps: 15, loop: true },
    { name: 'PICK', anim: 'PICK', loop: false },
    { name: 'HAMMER', anim: 'HAMMER', loop: true },
    { name: 'CART_STAND', anim: 'STAND1_cart_stand01', loop: true },
    { name: 'CART_WALK', anim: 'WALK_cart_walk', loop: true },
    ...styles.flatMap(s => [
      { name: `STAND1@${s}`, anim: 'STAND1', from: `${g}_${s}`, loop: true },
      { name: `WALK@${s}`, anim: 'WALK', from: `${g}_${s}`, loop: true },
    ]),
    { name: 'SIT_CHAIR', town: 'SIT_CHAIR', loop: true, optional: true },
    { name: 'CARRY', town: 'CARRY', loop: true, optional: true },
    { name: 'TALK', town: 'TALK', loop: true, optional: true },
    { name: 'SWEEP', town: 'SWEEP', loop: true, optional: true },
  ]
}

const outfit = (gender: TownGender, set: string, extra: string[] = []) => {
  const g = gender === 'male' ? 'M' : 'W'
  return ['BA', 'LA', 'FA', ...extra].map(p => `ITEM_CH_${g}_${set}_${p}_A`)
}

/**
 * The 18 people (TOWN_LIFE §3.2: 3 garment sets × hat or not × the faces; one LIGHT protector set each for a
 * militia look). Order = rank: the first 5 of each gender are Medium's, the next 2 High's, the last 2 Ultra's.
 */
export const TOWN_PEOPLE: readonly PersonSpec[] = [
  { id: 'm01', kind: 'person', gender: 'male', body: 'chinaman_merchant', items: outfit('male', 'CLOTHES_01'), rank: 'medium' },
  { id: 'm02', kind: 'person', gender: 'male', body: 'chinaman_scholar', items: outfit('male', 'CLOTHES_02', ['HA']), rank: 'medium' },
  { id: 'm03', kind: 'person', gender: 'male', body: 'chinaman_monk', items: outfit('male', 'CLOTHES_03'), rank: 'medium' },
  { id: 'm04', kind: 'person', gender: 'male', body: 'chinaman_nobleboy', items: outfit('male', 'CLOTHES_01', ['HA', 'AA']), rank: 'medium' },
  { id: 'm05', kind: 'person', gender: 'male', body: 'chinaman_warrior', items: outfit('male', 'CLOTHES_02', ['AA']), rank: 'medium' },
  { id: 'm06', kind: 'person', gender: 'male', body: 'chinaman_adventurer', items: outfit('male', 'CLOTHES_03', ['HA']), rank: 'high' },
  { id: 'm07', kind: 'person', gender: 'male', body: 'chinaman_performer', items: outfit('male', 'LIGHT_01'), rank: 'high' },
  { id: 'm08', kind: 'person', gender: 'male', body: 'chinaman_priest', items: outfit('male', 'CLOTHES_02'), rank: 'ultra' },
  { id: 'm09', kind: 'person', gender: 'male', body: 'chinaman_tattoo', items: outfit('male', 'CLOTHES_01', ['AA']), rank: 'ultra' },
  { id: 'w01', kind: 'person', gender: 'female', body: 'chinawoman_merchant', items: outfit('female', 'CLOTHES_01'), rank: 'medium' },
  { id: 'w02', kind: 'person', gender: 'female', body: 'chinawoman_noblegirl', items: outfit('female', 'CLOTHES_02', ['HA']), rank: 'medium' },
  { id: 'w03', kind: 'person', gender: 'female', body: 'chinawoman_kisaeng', items: outfit('female', 'CLOTHES_03'), rank: 'medium' },
  { id: 'w04', kind: 'person', gender: 'female', body: 'chinawoman_scholar', items: outfit('female', 'CLOTHES_01', ['HA']), rank: 'medium' },
  { id: 'w05', kind: 'person', gender: 'female', body: 'chinawoman_adventurer', items: outfit('female', 'CLOTHES_02', ['AA']), rank: 'medium' },
  { id: 'w06', kind: 'person', gender: 'female', body: 'chinawoman_fox', items: outfit('female', 'CLOTHES_03', ['HA']), rank: 'high' },
  { id: 'w07', kind: 'person', gender: 'female', body: 'chinawoman_warrior', items: outfit('female', 'LIGHT_01'), rank: 'high' },
  { id: 'w08', kind: 'person', gender: 'female', body: 'chinawoman_assassin', items: outfit('female', 'CLOTHES_02'), rank: 'ultra' },
  { id: 'w09', kind: 'person', gender: 'female', body: 'chinawoman_necromencerw', items: outfit('female', 'CLOTHES_01', ['AA']), rank: 'ultra' },
]

const STAND_WALK_RUN: TownClipSpec[] = [
  { name: 'STAND1', anim: 'STAND1', loop: true },
  { name: 'WALK', anim: 'WALK', loop: true },
  { name: 'RUN', anim: 'RUN', loop: true },
]

/**
 * Guards on patrol (the hireable mercenaries: the only retail soldiers with a walk), the event NPC elders and child
 * (stand only), and the animals of TOWN_LIFE §4 plus the porters' pack horse and donkey and the rider's horse (§3.1).
 * Ranks follow §8.2's draw counts (Medium: 2 guards + chicken, cat, dog).
 */
export const TOWN_MODELS: readonly ModelSpec[] = [
  { id: 'guard_spear', kind: 'guard', bsr: 'res/cos/ch_guard_spear.bsr', clips: [...STAND_WALK_RUN, { name: 'STAND2', anim: 'STAND2', loop: true, optional: true }], rank: 'medium' },
  { id: 'guard_bow', kind: 'guard', bsr: 'res/cos/ch_guard_bow.bsr', clips: [...STAND_WALK_RUN, { name: 'STAND2', anim: 'STAND2', loop: true, optional: true }], rank: 'medium' },
  { id: 'elder_m', kind: 'elder', bsr: 'res/npc/npc/npc_ch_event_ grandfather.bsr', clips: [{ name: 'STAND1', anim: 'STAND1', loop: true }], rank: 'high' },
  { id: 'elder_w', kind: 'elder', bsr: 'res/npc/npc/npc_ch_event_ grandmother.bsr', clips: [{ name: 'STAND1', anim: 'STAND1', loop: true }], rank: 'high' },
  { id: 'child', kind: 'elder', bsr: 'res/npc/npc/npc_ch_event_ child.bsr', clips: [{ name: 'STAND1', anim: 'STAND1', loop: true }], rank: 'high' },
  { id: 'chicken', kind: 'animal', bsr: 'res/npc/animal/cj_chicken.bsr', clips: [{ name: 'STAND1', anim: 'STAND1', fps: 15, loop: true }], rank: 'medium' },
  { id: 'cat', kind: 'animal', bsr: 'res/cos/p_cat.bsr', clips: [...STAND_WALK_RUN, { name: 'EMOTION01', anim: 'EMOTION01', loop: false }, { name: 'PICK', anim: 'PICK', loop: false }], rank: 'medium' },
  { id: 'dog', kind: 'animal', bsr: 'res/cos/p_raccoondog.bsr', clips: [...STAND_WALK_RUN, { name: 'EMOTION01', anim: 'EMOTION01', loop: false }, { name: 'PICK', anim: 'PICK', loop: false }], rank: 'medium' },
  { id: 'packhorse', kind: 'animal', bsr: 'res/cos/t_horse1.bsr', clips: STAND_WALK_RUN, rank: 'high' },
  { id: 'donkey', kind: 'animal', bsr: 'res/cos/t_donkey.bsr', clips: STAND_WALK_RUN, rank: 'ultra' },
  { id: 'horse', kind: 'animal', bsr: 'res/cos/c_horse1.bsr', clips: STAND_WALK_RUN, rank: 'high' },
]

// ---- the dresser ---------------------------------------------------------------------------------------------------

/** One source glb of a variant and which of its skinned mesh nodes to take (lower-case names; null: all). */
export interface DressPart {
  label: string
  doc: Document
  meshes: ReadonlySet<string> | null
}

/** The skeleton a variant is skinned to: the canonical skin's joints (VAT order) and inverse bind matrices. */
export interface DressSkeleton {
  name: string
  /** The glb whose joint nodes (names, rest TRS, hierarchy) the variant copies. */
  doc: Document
  joints: string[]
  ibm: Float32Array
}

export interface DressedPartInfo {
  label: string
  mesh: string
  /**
   * The part's first vertex in the merged mesh and its vertex count; its first `sourceCount` vertices are the source
   * primitive's, in order (then the tile splits, normaliseTiles). Its mirrored copy, if any, follows later.
   */
  start: number
  count: number
  sourceCount: number
  mirrored: boolean
}

export interface DressedVariant {
  doc: Document
  triangles: number
  vertices: number
  atlas: { width: number, height: number, image: RgbaImage }
  /** The retail emissive the material had (vertex-weighted over the parts), zeroed in the glb (see the header). */
  selfLit: [number, number, number]
  /** Bind-pose height (m, max y − min y). */
  heightM: number
  doubleSided: boolean
  alphaMode: 'OPAQUE' | 'MASK'
  parts: DressedPartInfo[]
  warnings: string[]
}

/** Inverse bind matrices of two skins may differ by float noise only (they come from the same .bsk). */
export const IBM_TOLERANCE = 1e-4

/** The skeleton of `doc`'s first skin: joint names in skin order and their inverse bind matrices. */
export function skeletonOf(name: string, doc: Document): DressSkeleton {
  const skin = doc.getRoot().listSkins()[0]
  if (!skin) throw new Error(`${name}: no skin`)
  return { name, doc, joints: skin.listJoints().map(j => j.getName()), ibm: ibmOf(skin) }
}

function ibmOf(skin: Skin): Float32Array {
  const n = skin.listJoints().length
  const acc = skin.getInverseBindMatrices()
  const out = new Float32Array(n * 16)
  if (!acc) {
    for (let j = 0; j < n; j++) for (let k = 0; k < 16; k += 5) out[j * 16 + k] = 1
    return out
  }
  const e: number[] = []
  for (let j = 0; j < n; j++) out.set(acc.getElement(j, e), j * 16)
  return out
}

interface SourceTexture {
  key: string
  bytes: Uint8Array | null
  factor: number[]
  opaque: boolean
  uv: [number, number, number, number]
}

interface PartGeometry {
  label: string
  mesh: string
  /** Vertices of the source primitive (the first ones of `pos`). */
  sourceCount: number
  pos: number[]
  nrm: number[]
  uv: number[]
  joints: number[]
  weights: number[]
  indices: number[]
  tex: SourceTexture
  doubleSided: boolean
  mask: boolean
  emissive: number[]
  metallic: number
  roughness: number
}

const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex').slice(0, 16)

function textureOf(mat: Material | null, textures: Map<string, SourceTexture>): SourceTexture {
  const tex = mat?.getBaseColorTexture() ?? null
  const bytes = tex?.getImage() ?? null
  const factor = mat?.getBaseColorFactor() ?? [1, 1, 1, 1]
  const opaque = (mat?.getAlphaMode() ?? 'OPAQUE') === 'OPAQUE'
  const key = `${bytes ? sha1(bytes) : 'flat'}:${factor.map(f => f.toFixed(4)).join(',')}:${opaque ? 'o' : 'a'}`
  let t = textures.get(key)
  if (!t) textures.set(key, (t = { key, bytes, factor, opaque, uv: [Infinity, Infinity, -Infinity, -Infinity] }))
  return t
}

/** Reads every triangle primitive of the part's skinned mesh nodes, joints remapped by name onto `skel`. */
function readPart(part: DressPart, skel: DressSkeleton, textures: Map<string, SourceTexture>, warnings: string[]): PartGeometry[] {
  const index = new Map(skel.joints.map((n, i) => [n, i]))
  const out: PartGeometry[] = []
  const nodes = part.doc.getRoot().listNodes().filter(n => n.getMesh() && n.getSkin())
  for (const node of nodes) {
    if (part.meshes && !part.meshes.has(node.getName().toLowerCase())) continue
    const skin = node.getSkin()!
    const names = skin.listJoints().map(j => j.getName())
    const map = names.map(n => {
      const i = index.get(n)
      if (i === undefined) throw new Error(`${part.label}: joint ${JSON.stringify(n)} is not in ${skel.name}`)
      return i
    })
    const ibm = ibmOf(skin)
    const checked = new Set<number>()
    for (const prim of node.getMesh()!.listPrimitives()) {
      if (prim.getMode() !== 4) {
        warnings.push(`${part.label}/${node.getName()}: primitive mode ${prim.getMode()} skipped`)
        continue
      }
      const g = readPrimitive(prim, map, part.label, node.getName(), textures)
      // the shared VAT is only right when this part was bound like the skeleton's own skin
      for (let v = 0; v < g.joints.length; v++) {
        if (g.weights[v]! <= 0) continue
        const local = names.indexOf(skel.joints[g.joints[v]!]!)
        if (checked.has(local)) continue
        checked.add(local)
        const j = g.joints[v]!
        let d = 0
        for (let k = 0; k < 16; k++) d = Math.max(d, Math.abs(ibm[local * 16 + k]! - skel.ibm[j * 16 + k]!))
        if (d > IBM_TOLERANCE) throw new Error(`${part.label}/${node.getName()}: inverse bind of ${skel.joints[j]} differs from ${skel.name}'s by ${d.toExponential(2)}`)
      }
      out.push(g)
    }
  }
  return out
}

function readPrimitive(prim: Primitive, map: number[], label: string, mesh: string, textures: Map<string, SourceTexture>): PartGeometry {
  const P = prim.getAttribute('POSITION')!
  const N = prim.getAttribute('NORMAL')
  const T = prim.getAttribute('TEXCOORD_0')
  const J = prim.getAttribute('JOINTS_0')
  const W = prim.getAttribute('WEIGHTS_0')
  if (!J || !W) throw new Error(`${label}/${mesh}: not skinned (no JOINTS_0 / WEIGHTS_0)`)
  if (prim.getAttribute('JOINTS_1')) throw new Error(`${label}/${mesh}: more than 4 influences (JOINTS_1) is not supported`)
  const n = P.getCount()
  const mat = prim.getMaterial()
  const tex = textureOf(mat, textures)
  const g: PartGeometry = {
    label, mesh, sourceCount: n, pos: [], nrm: [], uv: [], joints: [], weights: [], indices: [], tex,
    doubleSided: mat?.getDoubleSided() ?? false,
    mask: (mat?.getAlphaMode() ?? 'OPAQUE') !== 'OPAQUE',
    emissive: mat?.getEmissiveFactor() ?? [0, 0, 0],
    metallic: mat?.getMetallicFactor() ?? 0,
    roughness: mat?.getRoughnessFactor() ?? 1,
  }
  const p3 = [0, 0, 0]
  const n3 = [0, 1, 0]
  const t2 = [0, 0]
  const j4 = [0, 0, 0, 0]
  const w4 = [0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    P.getElement(i, p3)
    g.pos.push(p3[0]!, p3[1]!, p3[2]!)
    if (N) N.getElement(i, n3)
    // retail normals are not always unit length (the glTF-Validator refuses them)
    const len = Math.hypot(n3[0]!, n3[1]!, n3[2]!)
    if (len > 1e-8) g.nrm.push(n3[0]! / len, n3[1]! / len, n3[2]! / len)
    else g.nrm.push(0, 1, 0)
    if (T) T.getElement(i, t2)
    const u = t2[0]!
    const v = t2[1]!
    g.uv.push(u, v)
    const jj = J.getElement(i, j4)
    const ww = W.getElement(i, w4)
    const sum = ww.reduce((s, x) => s + Math.max(0, x), 0) || 1
    for (let k = 0; k < 4; k++) {
      const w = Math.max(0, ww[k] ?? 0) / sum
      g.weights.push(w)
      g.joints.push(w > 0 ? map[jj[k]!]! : 0)
    }
  }
  const I = prim.getIndices()
  if (I) for (let i = 0; i < I.getCount(); i++) g.indices.push(I.getScalar(i))
  else for (let i = 0; i < n; i++) g.indices.push(i)
  normaliseTiles(g)
  for (let i = 0; i < g.uv.length; i += 2) {
    tex.uv[0] = Math.min(tex.uv[0], g.uv[i]!)
    tex.uv[1] = Math.min(tex.uv[1], g.uv[i + 1]!)
    tex.uv[2] = Math.max(tex.uv[2], g.uv[i]!)
    tex.uv[3] = Math.max(tex.uv[3], g.uv[i + 1]!)
  }
  return g
}

/**
 * Moves every triangle's UVs by whole tiles towards 0..1 (the floor of its smallest u and v): a piece that maps the
 * texture twice (the raccoon dog's body runs v 0..2) then needs one tile of atlas, not two. The texture repeats, so
 * the texels read are the same. A vertex keeps its place and takes the shift of the first triangle that uses it; a
 * vertex shared with a triangle of another tile is split, the copy appended after the source's vertices (so the first
 * `count` vertices stay the source's, in order).
 */
export function normaliseTiles(g: Pick<PartGeometry, 'pos' | 'nrm' | 'uv' | 'joints' | 'weights' | 'indices'>): void {
  const tri = g.indices.length / 3
  const n = g.pos.length / 3
  const shift: Array<[number, number]> = []
  let moved = false
  for (let t = 0; t < tri; t++) {
    let u0 = Infinity
    let v0 = Infinity
    for (let k = 0; k < 3; k++) {
      const i = g.indices[t * 3 + k]!
      u0 = Math.min(u0, g.uv[i * 2]!)
      v0 = Math.min(v0, g.uv[i * 2 + 1]!)
    }
    const s = [Math.floor(u0 + 1e-4), Math.floor(v0 + 1e-4)] as [number, number]
    shift.push(s)
    if (s[0] || s[1]) moved = true
  }
  if (!moved) return
  const own: Array<[number, number] | undefined> = new Array(n)
  for (let t = 0; t < tri; t++) for (let k = 0; k < 3; k++) own[g.indices[t * 3 + k]!] ??= shift[t]
  const uv = g.uv.slice()
  for (let i = 0; i < n; i++) {
    const s = own[i]
    if (s) {
      uv[i * 2] = uv[i * 2]! - s[0]
      uv[i * 2 + 1] = uv[i * 2 + 1]! - s[1]
    }
  }
  const made = new Map<string, number>()
  for (let t = 0; t < tri; t++) {
    const [ku, kv] = shift[t]!
    for (let k = 0; k < 3; k++) {
      const i = g.indices[t * 3 + k]!
      const o = own[i]!
      if (o[0] === ku && o[1] === kv) continue
      const key = `${i}:${ku}:${kv}`
      let j = made.get(key)
      if (j === undefined) {
        j = g.pos.length / 3
        made.set(key, j)
        g.pos.push(g.pos[i * 3]!, g.pos[i * 3 + 1]!, g.pos[i * 3 + 2]!)
        g.nrm.push(g.nrm[i * 3]!, g.nrm[i * 3 + 1]!, g.nrm[i * 3 + 2]!)
        uv.push(g.uv[i * 2]! - ku, g.uv[i * 2 + 1]! - kv)
        for (let c = 0; c < 4; c++) {
          g.joints.push(g.joints[i * 4 + c]!)
          g.weights.push(g.weights[i * 4 + c]!)
        }
      }
      g.indices[t * 3 + k] = j
    }
  }
  g.uv = uv
}

async function sourceImage(t: SourceTexture): Promise<RgbaImage> {
  const img = t.bytes ? await decodeImage(t.bytes) : { width: 4, height: 4, data: new Uint8Array(64).fill(255) }
  if (t.factor.some(f => Math.abs(f - 1) > 1e-6)) {
    for (let i = 0; i < img.data.length; i++) img.data[i] = Math.round(img.data[i]! * Math.min(1, Math.max(0, t.factor[i % 4]!)))
  }
  return img
}

/**
 * Dresses one variant: every part's skinned primitives merged into one primitive skinned to `skel` (joints by name),
 * their textures into one atlas, one material. Throws when a part does not fit the skeleton (a missing joint, another
 * bind) or the atlas does not fit 1024²; the triangle budget is the caller's report.
 */
export async function dressVariant(id: string, skel: DressSkeleton, parts: readonly DressPart[]): Promise<DressedVariant> {
  const warnings: string[] = []
  const textures = new Map<string, SourceTexture>()
  const geos = parts.flatMap(p => readPart(p, skel, textures, warnings))
  if (!geos.length) throw new Error(`${id}: nothing to draw`)
  const sources: AtlasSource[] = []
  for (const t of textures.values()) {
    if (!(t.uv[2] >= t.uv[0])) continue
    sources.push({ key: t.key, image: await sourceImage(t), opaque: t.opaque, uv: t.uv })
  }
  const atlas = buildAtlas(sources)
  if (!atlas) throw new Error(`${id}: the textures do not fit a ${VARIANT_MAX_ATLAS}² atlas`)
  const allDouble = geos.every(g => g.doubleSided)
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  const joints: number[] = []
  const weights: number[] = []
  const indices: number[] = []
  const info: DressedPartInfo[] = []
  const emissive = [0, 0, 0]
  const append = (g: PartGeometry, mirror: boolean) => {
    const base = pos.length / 3
    const n = g.pos.length / 3
    const p = atlas.placements.get(g.tex.key)!
    for (let i = 0; i < n; i++) {
      pos.push(g.pos[i * 3]!, g.pos[i * 3 + 1]!, g.pos[i * 3 + 2]!)
      const s = mirror ? -1 : 1
      nrm.push(s * g.nrm[i * 3]!, s * g.nrm[i * 3 + 1]!, s * g.nrm[i * 3 + 2]!)
      uv.push(...atlasUv(p, atlas.width, atlas.height, g.uv[i * 2]!, g.uv[i * 2 + 1]!))
      for (let k = 0; k < 4; k++) {
        joints.push(g.joints[i * 4 + k]!)
        weights.push(g.weights[i * 4 + k]!)
      }
    }
    for (let t = 0; t + 2 < g.indices.length; t += 3) {
      const [a, b, c] = [g.indices[t]! + base, g.indices[t + 1]! + base, g.indices[t + 2]! + base]
      if (mirror) indices.push(a, c, b)
      else indices.push(a, b, c)
    }
    if (!mirror) for (let k = 0; k < 3; k++) emissive[k] = emissive[k]! + (g.emissive[k] ?? 0) * n
    return { start: base, count: n }
  }
  for (const g of geos) info.push({ label: g.label, mesh: g.mesh, ...append(g, false), sourceCount: g.sourceCount, mirrored: false })
  if (!allDouble) {
    for (const g of geos) {
      if (!g.doubleSided) continue
      append(g, true)
      info.find(i => i.label === g.label && i.mesh === g.mesh && !i.mirrored)!.mirrored = true
    }
  }
  const vertsOwn = geos.reduce((s, g) => s + g.pos.length / 3, 0)
  const selfLit = emissive.map(e => Math.round((e / vertsOwn) * 1e4) / 1e4) as [number, number, number]
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 1; i < pos.length; i += 3) {
    minY = Math.min(minY, pos[i]!)
    maxY = Math.max(maxY, pos[i]!)
  }
  const alphaMode = geos.some(g => g.mask) ? 'MASK' : 'OPAQUE'
  const doc = buildVariantDoc(id, skel, { pos, nrm, uv, joints, weights, indices }, {
    alphaMode, doubleSided: allDouble, metallic: geos[0]!.metallic, roughness: geos[0]!.roughness,
  }, atlas.image)
  return {
    doc: await doc,
    triangles: indices.length / 3,
    vertices: pos.length / 3,
    atlas: { width: atlas.width, height: atlas.height, image: atlas.image },
    selfLit,
    heightM: Math.round((maxY - minY) * 1000) / 1000,
    doubleSided: allDouble,
    alphaMode,
    parts: info,
    warnings,
  }
}

interface Merged {
  pos: number[]
  nrm: number[]
  uv: number[]
  joints: number[]
  weights: number[]
  indices: number[]
}

/**
 * The variant glb: the skeleton's joint nodes (names, rest TRS, hierarchy, copied from `skel.doc`), one skin in VAT
 * order with the skeleton's inverse binds, one mesh node at the scene root, one primitive, one material with the atlas,
 * emissive black. No animation: the VAT is the animation.
 */
async function buildVariantDoc(id: string, skel: DressSkeleton, m: Merged,
  mat: { alphaMode: 'OPAQUE' | 'MASK', doubleSided: boolean, metallic: number, roughness: number }, atlas: RgbaImage): Promise<Document> {
  const doc = new Document()
  doc.getRoot().getAsset().generator = 'sro-convert town (TL-V)'
  const buffer = doc.createBuffer()
  const scene = doc.createScene('town')
  doc.getRoot().setDefaultScene(scene)
  // joints: the canonical skin's joints and every ancestor they hang under, same names and rest TRS
  const srcSkin = skel.doc.getRoot().listSkins()[0]!
  const srcJoints = srcSkin.listJoints()
  const made = new Map<Node, Node>()
  const copy = (n: Node): Node => {
    let c = made.get(n)
    if (c) return c
    c = doc.createNode(n.getName()).setTranslation(n.getTranslation()).setRotation(n.getRotation()).setScale(n.getScale())
    made.set(n, c)
    const p = n.getParentNode()
    if (p) copy(p).addChild(c)
    else scene.addChild(c)
    return c
  }
  const joints = srcJoints.map(copy)
  const ibm = doc.createAccessor('ibm').setType('MAT4').setArray(new Float32Array(skel.ibm)).setBuffer(buffer)
  const skin = doc.createSkin(`town_${id}_skin`).setInverseBindMatrices(ibm)
  for (const j of joints) skin.addJoint(j)
  const top = srcJoints.find(j => !srcJoints.includes(j.getParentNode()!))
  if (top) skin.setSkeleton(made.get(top)!)
  const n = m.pos.length / 3
  const acc = (name: string, type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR', array: Float32Array | Uint8Array | Uint16Array | Uint32Array) =>
    doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer)
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('position', 'VEC3', new Float32Array(m.pos)))
    .setAttribute('NORMAL', acc('normal', 'VEC3', new Float32Array(m.nrm)))
    .setAttribute('TEXCOORD_0', acc('uv', 'VEC2', new Float32Array(m.uv)))
    .setAttribute('JOINTS_0', acc('joints', 'VEC4', skel.joints.length < 256 ? new Uint8Array(m.joints) : new Uint16Array(m.joints)))
    .setAttribute('WEIGHTS_0', acc('weights', 'VEC4', new Float32Array(m.weights)))
    .setIndices(acc('indices', 'SCALAR', n < 65536 ? new Uint16Array(m.indices) : new Uint32Array(m.indices)))
  const texture = doc.createTexture(`town_${id}_atlas`).setImage(await encodePng(atlas)).setMimeType('image/png').setURI(`town_${id}_atlas.png`)
  const material = doc.createMaterial(`town_${id}`)
    .setBaseColorTexture(texture)
    .setAlphaMode(mat.alphaMode)
    .setAlphaCutoff(0.5)
    .setDoubleSided(mat.doubleSided)
    .setMetallicFactor(mat.metallic)
    .setRoughnessFactor(mat.roughness)
    .setEmissiveFactor([0, 0, 0])
  // clamped (nothing repeats past a rectangle's gutter), trilinear as the retail materials
  material.getBaseColorTextureInfo()!.setWrapS(33071).setWrapT(33071).setMinFilter(9987).setMagFilter(9729)
  prim.setMaterial(material)
  const mesh = doc.createMesh(`town_${id}`).addPrimitive(prim)
  scene.addChild(doc.createNode(`town_${id}`).setMesh(mesh).setSkin(skin))
  return doc
}

// ---- people parts -----------------------------------------------------------------------------------------------------

/** The parts of a dressed person by the game's composition rules: the body's shown meshes, then each skinned item. */
export async function personParts(spec: PersonSpec, manifest: EquipmentManifest, bodyDoc: Document,
  itemDoc: (glb: string) => Promise<Document>): Promise<{ parts: DressPart[], character: string }> {
  const character = manifest.characters.find(c => c.glb.toLowerCase().endsWith(`/${spec.body.toLowerCase()}.glb`))
  if (!character) throw new Error(`${spec.id}: body ${spec.body} is not in the equipment manifest`)
  if (character.gender !== spec.gender) throw new Error(`${spec.id}: ${spec.body} is ${character.gender}`)
  const comp = composeEquipment(manifest, character.code, spec.items)
  if (comp.rejected.length) throw new Error(`${spec.id}: ${comp.rejected.map(r => `${r.code} ${r.reason} (${r.detail})`).join('; ')}`)
  const parts: DressPart[] = [{ label: spec.body, doc: bodyDoc, meshes: new Set(comp.show.map(s => s.toLowerCase())) }]
  for (const b of comp.bind) {
    if (b.kind !== 'skinned') continue
    // every skinned mesh of the item glb (the manifest's list may leave out a two-sided piece such as `*_2s`)
    parts.push({ label: b.code, doc: await itemDoc(b.glb), meshes: null })
  }
  return { parts, character: character.code }
}
