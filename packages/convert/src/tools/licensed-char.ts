#!/usr/bin/env node
// Licensed characters (docs/CHARACTERS.md §16): the River Spirit Waterbender (IdaFaber, Fab Standard License) as the
// game's male and female player bodies behind `?newchar=1`. The licensed pack is NEVER in git and never in the public
// release: this tool reads it from a path you give it and writes only under work/ (git-ignored):
//   blender -b --factory-startup --python packages/convert/src/tools/licensed/waterbender-export.py -- --src "<pack>"
//   pnpm tsx packages/convert/src/tools/licensed-char.ts --src "<pack>" [--in work/licensed/waterbender/export]
// (or set SRO_WATERBENDER_SRC). Writes work/out/char/licensed/waterbender/waterbender_<f|m>_<nn>.{glb,json} and the same
// under work/out-opt/. A server without these files plays the existing characters (the game checks the sidecar first).
//
// What it does to the Blender export: keeps the artist's skeleton and weights untouched; drops the vertex-colour masks
// (Babylon would tint the albedo with them); names meshes after their objects; assigns the pack's 4K PBR maps
// downscaled to the texture budget (base colour / normal 2048, metal-roughness 1024; UE DirectX normals → OpenGL
// green); builds the retarget spec (apps/game/src/three/retarget.ts) from the retail Chinese man / woman rest and the
// body's rest, checks it, and copies the retail clip index + animation packs into the sidecar.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeIO, type Document, type Material, type Texture } from '@gltf-transform/core'
import { REPO_ROOT } from '../node-io.ts'
import { CLOTH_DYE_FILES, clothDyeMaps, clothWearMap } from './licensed/cloth-dye.ts'
import { buildRetargetSpec, makeRetargeter, qinv, qmul, type Quat, type RestJoint, type Vec3 } from '../../../../apps/game/src/three/retarget.ts'

const args = process.argv.slice(2)
const flag = (k: string, d?: string) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1]! : d
}
const WORK = join(REPO_ROOT, 'work')
const SRC = flag('--src', process.env.SRO_WATERBENDER_SRC)
const IN = resolve(flag('--in', join(WORK, 'licensed/waterbender/export'))!)
const ONLY = new Set((flag('--only', '') ?? '').split(',').filter(Boolean))
// `--out <dir>`: one other output directory (a trial build that leaves the served files alone)
const OUTS = flag('--out') ? [resolve(flag('--out')!)] : [join(WORK, 'out/char/licensed/waterbender'), join(WORK, 'out-opt/char/licensed/waterbender')]
const RETAIL = { f: 'chinawoman_adventurer', m: 'chinaman_adventurer' } as const
/**
 * The head's makeup variant (Textures/Base/T_HEAD_<F|M>_BaseColor_<v>.png; CHARACTERS §16.3): the ones closest to the
 * artist's renders (girl: liner, painted lower lashes, light brows; boy: dark brows, reddish lower lids). `--face-f`,
 * `--face-m` pick another; `--faces-f 16_04,27,...` / `--faces-m` also write those as swappable head maps (`faces/<g>_<v>.jpg`, the
 * game's `?ncface=`, the creator later).
 */
export const FACE_DEFAULT = { f: '16_04', m: '04' } as const
const FACE = { f: flag('--face-f', FACE_DEFAULT.f)!, m: flag('--face-m', FACE_DEFAULT.m)! }
const FACES = { f: (flag('--faces-f', '') ?? '').split(',').filter(Boolean), m: (flag('--faces-m', '') ?? '').split(',').filter(Boolean) }

/**
 * One material's maps (paths under Textures/), checked channel by channel against the pack (CHARACTERS §16.1):
 * - normal maps differ per map: the curl test (dR/drow vs dG/dcol: + DirectX, − OpenGL) and, where a height map
 *   exists, the slope test agree: clothes, lingerie, head and the male body are DirectX (green flipped here), the female
 *   body (T_BODY_F_UPD), the hair and the eyes OpenGL;
 * - MaskMap is HDRP's: R metallic, G occlusion, B detail mask, A smoothness (A = 1 − the pack's Roughness map, r −0.99);
 *   the clothes' OcclusionRoughnessMetallic is already glTF's layout (= MaskMap G / 1 − A / R, r ≥ 0.997).
 */
export type Slot = {
  /** No maps: a plain colour (sRGB 0..1; the lingerie the pack ships untextured). */
  flat?: [number, number, number]
  base: string
  /** Drawn over `base` first (the eyes: the pack's pupil sample on an iris map without one). */
  overlay?: string
  /** sRGB base colour size (default 2048). */
  size?: number
  /** RGB from `base` × tint, alpha from this map's A (the hair). */
  alphaFrom?: string
  tint?: [number, number, number]
  /** Albedo × mix(min, 1, this map's R): the hair's root-to-tip darkening, the eyes' lid shadow. */
  darken?: { file: string; min: number }
  /**
   * Skin (head): lift the makeup's painted under-eye shadow (§16.7). `bare` is the pack's no-makeup head map; the makeup
   * layer is this map's luminance over the bare one's; under each eye (UNDER_EYE ellipses, feathered) its smooth part
   * is pulled `k` of the way (in log) to the cheek's level just below. Lid line, lashes and freckles keep their contrast.
   */
  underEye?: { bare: string; k: number }
  /** Skin: saturation and gain on the albedo (sRGB): the warmth subsurface scattering gives in UE, which the game lacks. */
  grade?: { sat: number; gain: number; warm?: [number, number, number] }
  normal?: string
  normalDx?: boolean
  /** ORM from an HDRP MaskMap: R from G (occlusion), G = 1 − A (roughness), B = 0 (skin is not metal). */
  mask?: string
  /** ORM from a glTF-layout map as it is. */
  orm?: string
  /** ORM: R from this map's R (occlusion), G = 1, B = 0 (the roughness factor scales it). */
  ao?: string
  ormSize?: number
  roughness?: number
  alpha?: 'MASK' | 'BLEND'
  cutoff?: number
  double?: boolean
}
/** The iris map (Textures/Base/Eyes/T_EYES_BaseColor_<v>.png, CHARACTERS §16.5): 31–36 have the pupil baked in. */
export const EYE_DEFAULT = { f: '01', m: '31' } as const
/**
 * §16.3 warmed the skin ×(1, 0.94, 0.86) against a lavender, environment-only face. §16.7: with the face key actually on
 * the face (it lit the back of the head) the light is neutral and that warmth over-saturated it: noon cheek g/r 0.68,
 * b/r 0.55 against the albedo's 0.74 / 0.69 and the artist render's 0.83 / 0.80 (orange, oily). Back to the pack's own
 * hue; `--skin-warm r,g,b` for the A/B.
 */
export const SKIN_GRADE = { sat: 1.0, gain: 0.97, warm: ((flag('--skin-warm', '1,1,1') ?? '1,1,1').split(',').map(Number) as [number, number, number]) }
/**
 * §16.7: the under-eye zones of the pack's head UVs (both genders share them), in 0..1 UV: an ellipse under each lower
 * lid (centre, radii) and the cheek band below it that sets the target level. Measured on the makeup layer
 * (T_HEAD_F_BaseColor_16_04 / _00, T_HEAD_M_BaseColor_04 / _00): the painted shadow sits 0.69 of the cheek's luminance
 * (girl) / 0.69 (boy) where the bare map is flat (0.99).
 */
export const UNDER_EYE = {
  eyes: [[1735 / 4096, 1496 / 4096], [2385 / 4096, 1496 / 4096]] as [number, number][],
  r: [175 / 4096, 42 / 4096] as [number, number],
  cheek: [1580 / 4096, 1630 / 4096] as [number, number],
  /** The feather: the lift fades out from the ellipse's edge to this × its radii (the lid rim above stays as painted). */
  feather: 1.4,
  /** The most a pixel is brightened (the band's darkest core). */
  maxLift: 1.45,
}
/** §16.7: how far the painted under-eye shadow is lifted to the cheek's level (log space; 0 off, 1 flat). */
export const UNDER_EYE_K = 0.75
/** `--under-eye-k 0` builds the maps as painted (the A/B). */
const UE_K = Number(flag('--under-eye-k', String(UNDER_EYE_K)))

/**
 * The under-eye lift on an RGB buffer (size² × 3, sRGB bytes), in place: see `Slot.underEye`. `bare`: the no-makeup map's
 * RGB at the same size. Returns the mean under-eye / cheek luminance ratio before and after (the measure of §16.7).
 */
export function liftUnderEye(rgb: Buffer, bare: Buffer, size: number, k: number): { before: number; after: number } {
  const n = size * size
  const lum = (b: Buffer, i: number) => 0.2126 * b[i * 3]! + 0.7152 * b[i * 3 + 1]! + 0.0722 * b[i * 3 + 2]!
  // the makeup layer's luminance, smoothed (a separable box ×3 ≈ gaussian, radius ≈ 0.2 % of the map)
  let m = new Float32Array(n)
  for (let i = 0; i < n; i++) m[i] = lum(rgb, i) / Math.max(1, lum(bare, i))
  const r = Math.max(1, Math.round(size * 0.002))
  const tmp = new Float32Array(n)
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < size; y++) {
      let acc = 0
      for (let x = -r; x <= r; x++) acc += m[y * size + Math.min(size - 1, Math.max(0, x))]!
      for (let x = 0; x < size; x++) {
        tmp[y * size + x] = acc / (2 * r + 1)
        acc += m[y * size + Math.min(size - 1, x + r + 1)]! - m[y * size + Math.max(0, x - r)]!
      }
    }
    for (let x = 0; x < size; x++) {
      let acc = 0
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(size - 1, Math.max(0, y)) * size + x]!
      for (let y = 0; y < size; y++) {
        m[y * size + x] = acc / (2 * r + 1)
        acc += tmp[Math.min(size - 1, y + r + 1) * size + x]! - tmp[Math.max(0, y - r) * size + x]!
      }
    }
  }
  const [rx, ry] = UNDER_EYE.r
  let sb = 0, sa = 0, sc = 0, nb = 0, nc = 0
  const lumAt = (x: number, y: number) => lum(rgb, y * size + x)
  for (const [cx, cy] of UNDER_EYE.eyes) {
    // the cheek's makeup level just below the zone, per column (blush and the face's sides keep their own level)
    let refAll = 0, rn = 0
    for (let y = Math.round(UNDER_EYE.cheek[0] * size); y < Math.round(UNDER_EYE.cheek[1] * size); y++)
      for (let x = Math.round((cx - rx * 0.6) * size); x < Math.round((cx + rx * 0.6) * size); x++) {
        refAll += m[y * size + x]!
        rn++
        sc += lumAt(x, y)
        nc++
      }
    refAll /= rn
    const below0 = Math.round((cy + ry * UNDER_EYE.feather) * size), below1 = Math.round((cy + ry * (UNDER_EYE.feather + 0.5)) * size)
    const refOf = (x: number) => {
      let a = 0
      for (let y = below0; y < below1; y++) a += m[y * size + x]!
      return Math.max(refAll * 0.9, Math.min(refAll * 1.1, a / Math.max(1, below1 - below0)))
    }
    const F = UNDER_EYE.feather
    const x0 = Math.floor((cx - rx * F) * size), x1 = Math.ceil((cx + rx * F) * size)
    const y0 = Math.floor((cy - ry * F) * size), y1 = Math.ceil((cy + ry * F) * size)
    const core: number[] = []
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot((x / size - cx) / rx, (y / size - cy) / ry)
        if (d >= F) continue
        const t = d <= 1 ? 1 : 1 - (d - 1) / (F - 1)
        const w = t * t * (3 - 2 * t)
        const i = y * size + x
        const lift = Math.min(UNDER_EYE.maxLift, Math.max(1, Math.pow(refOf(x) / Math.max(1e-3, m[i]!), k * w)))
        if (d <= 1) core.push(i)
        if (d <= 1) sb += lum(rgb, i)
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.min(255, Math.round(rgb[i * 3 + c]! * lift))
        if (d <= 1) sa += lum(rgb, i)
      }
    nb += core.length
  }
  const cheek = sc / Math.max(1, nc)
  return { before: sb / Math.max(1, nb) / cheek, after: sa / Math.max(1, nb) / cheek }
}

/** Material name → its maps. `g` picks the gendered ones. */
export function materialMaps(g: 'f' | 'm', face: string = FACE_DEFAULT[g]): Record<string, Slot> {
  const F = g === 'f'
  const clothes: Slot = { base: 'T_RiverSpirit_Clothes_BaseColor_01.png', normal: 'T_RiverSpirit_Clothes_Normal.png', normalDx: true, orm: 'T_RiverSpirit_Clothes_OcclusionRoughnessMetallic.png', ormSize: 2048 }
  const eyes: Slot = {
    // §16.5: the eye meshes ARE the centred layout of 01–36 (cornea front at UV 0.5, 0.5; iris edge ≈ 30° → r 0.12 =
    // the maps' iris r 0.11). 37 is not an albedo: its upper half is black (lid occlusion baked) and its sclera grey,
    // so the visible sclera was near-black and showed only the cornea's sky reflection (the blue eyeball).
    // girl 01 (light warm brown, the render's), boy 31 (grey); 31–36 carry a baked pupil, the others get the pack's
    // sample pupil drawn over them (HowTo_BulkEditMaps)
    base: `Base/Eyes/T_EYES_BaseColor_${EYE_DEFAULT[g]}.png`,
    ...(Number(EYE_DEFAULT[g]) <= 30 ? { overlay: 'Base/Eyes/T_EYES_PupilSample.png' } : {}),
    // the pack's eye occlusion (dark under the upper lid): in the albedo for the direct light, as occlusion for the sky
    darken: { file: 'Base/Eyes/T_EYES_AO.png', min: 0.5 },
    ao: 'Base/Eyes/T_EYES_AO.png', ormSize: 1024, roughness: 0.25,
  }
  return {
    MAT_BODY: F
      ? { base: 'Base/T_BODY_F_UPD_BaseColor_01.png', normal: 'Base/T_BODY_F_UPD_Normal_01.png', normalDx: false, mask: 'Base/T_BODY_F_UPD_MaskMap.png', ormSize: 2048, grade: SKIN_GRADE }
      : { base: 'Base/T_BODY_M_BaseColor.png', normal: 'Base/T_BODY_Normal_01.png', normalDx: true, mask: 'Base/T_BODY_MaskMap.png', ormSize: 2048, grade: SKIN_GRADE },
    MAT_HEAD: F
      ? { base: `Base/T_HEAD_F_BaseColor_${face}.png`, underEye: { bare: 'Base/T_HEAD_F_BaseColor_00.png', k: UE_K }, normal: 'Base/T_HEAD_Normal_01.png', normalDx: true, mask: 'Base/T_HEAD_F_MaskMap.png', ormSize: 2048, grade: SKIN_GRADE }
      : { base: `Base/T_HEAD_M_BaseColor_${face}.png`, underEye: { bare: 'Base/T_HEAD_M_BaseColor_00.png', k: UE_K }, normal: 'Base/T_HEAD_Normal_01.png', normalDx: true, mask: 'Base/T_HEAD_M_MaskMap.png', ormSize: 2048, grade: SKIN_GRADE },
    MAT_CLOTHES: clothes,
    // §16.9: the lingerie shown where no chest / legs piece is worn (the pack has no map for it: a plain dark linen)
    MAT_LINGERIE: { flat: [0.42, 0.36, 0.31], base: '', roughness: 1 },
    MAT_CLOTHES_sim: { ...clothes, double: true },
    MAT_EYES_L: eyes, MAT_EYES_R: eyes, MAT_EYE_L: eyes, MAT_EYE_R: eyes,
    MAT_LASHES: { base: 'Base/T_LASHES_01.png', size: 1024, alpha: 'BLEND', double: true, roughness: 0.6 },
    // the hair texture is grey (UE tints it): the colour from the matching BaseColor, the alpha from Transparent, darker
    // at the roots (Root: black at the root, white at the tip)
    MAT_HAIR: {
      base: F ? 'Base/Wavy/T_HAIR_WAVY_BaseColor_Black.png' : 'Base/Wavy/T_HAIR_WAVY_BaseColor_Natural.png',
      alphaFrom: 'Base/Wavy/T_HAIR_WAVY_Transparent.png',
      // the renders' male hair is a dark brown: the Natural colour darkened
      ...(F ? {} : { tint: [0.55, 0.5, 0.5] as [number, number, number] }),
      darken: { file: 'Base/Wavy/T_HAIR_WAVY_Root.png', min: 0.6 },
      normal: 'Base/Wavy/T_HAIR_WAVY_Normal.png', normalDx: false,
      ao: 'Base/Wavy/T_HAIR_WAVY_ambient.png', ormSize: 1024, roughness: 0.45,
      alpha: 'MASK', cutoff: 0.5, double: true,
    },
  }
}

const restOf = (doc: Document, names: Set<string> | null): RestJoint[] => {
  const nodes = doc.getRoot().listNodes().filter(n => !n.getMesh() && (!names || names.has(n.getName())))
  const inSet = new Set(nodes.map(n => n.getName()))
  return nodes.map(n => {
    const p = n.getParentNode()
    return { name: n.getName(), parent: p && inSet.has(p.getName()) ? p.getName() : null, t: [...n.getTranslation()] as Vec3, r: [...n.getRotation()] as Quat }
  })
}

async function texture(doc: Document, cache: Map<string, Texture>, key: string, make: () => Promise<{ data: Buffer; mime: string }>): Promise<Texture> {
  let t = cache.get(key)
  if (!t) {
    const { data, mime } = await make()
    t = doc.createTexture(key).setImage(new Uint8Array(data)).setMimeType(mime)
    cache.set(key, t)
  }
  return t
}

async function main(): Promise<void> {
  if (!SRC || !existsSync(join(SRC, 'Textures'))) throw new Error('licensed-char: --src <River Spirit Waterbender pack dir> (or SRO_WATERBENDER_SRC) is required')
  if (!existsSync(IN)) throw new Error(`licensed-char: no Blender export in ${IN} (run waterbender-export.py first)`)
  const sharp = (await import('sharp')).default
  const T = (p: string) => join(SRC, 'Textures', p)
  const io = new NodeIO()
  const files = readdirSync(IN).filter(f => /^waterbender_[fm]_\d\d\.glb$/.test(f)).filter(f => !ONLY.size || ONLY.has(f.slice(12, 16)))
  if (!files.length) throw new Error(`licensed-char: no waterbender_<f|m>_<nn>.glb in ${IN}`)
  const owners = new Map<'f' | 'm', { pieces: string[]; ownerSize: number; owner: string }>()
  for (const file of files) {
    const g = file[12] as 'f' | 'm'
    const variant = file.slice(14, 16)
    const doc = await io.read(join(IN, file))
    const root = doc.getRoot()

    // 1. geometry: the vertex-colour masks off, meshes named after their objects
    // LOD0 and the lower LODs (`<part>__LOD1` / `__LOD2`, waterbender-export.py; CHARACTERS §16.8)
    const lodTris = [0, 0, 0]
    for (const n of root.listNodes()) {
      const mesh = n.getMesh()
      if (!mesh) continue
      mesh.setName(n.getName())
      const lod = Number(/__LOD(\d)$/.exec(n.getName())?.[1] ?? 0)
      for (const p of mesh.listPrimitives()) {
        for (const s of p.listSemantics()) if (/^COLOR_/.test(s)) p.setAttribute(s, null)
        lodTris[lod] = (lodTris[lod] ?? 0) + (p.getIndices()?.getCount() ?? 0) / 3
      }
    }
    const tris = lodTris[0]!

    // 2. materials
    const maps = materialMaps(g, FACE[g])
    const cache = new Map<string, Texture>()
    const jpeg = (img: import('sharp').Sharp) => img.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer().then(data => ({ data, mime: 'image/jpeg' }))
    const channel = (f: string, k: 0 | 1 | 2 | 3, n: number) => sharp(T(f)).extractChannel(k).resize(n, n).raw().toBuffer()
    for (const m of root.listMaterials() as Material[]) {
      const s = maps[m.getName()]
      if (!s) {
        console.warn(`licensed-char: ${file}: material ${m.getName()} has no maps`)
        continue
      }
      const size = s.size ?? 2048
      if (s.flat) {
        const lin = s.flat.map(c => Math.pow(c, 2.2))
        m.setEmissiveFactor([0, 0, 0]).setBaseColorFactor([lin[0]!, lin[1]!, lin[2]!, 1]).setMetallicFactor(0).setRoughnessFactor(s.roughness ?? 1).setAlphaMode('OPAQUE')
        m.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null).setOcclusionTexture(null)
        continue
      }
      m.setEmissiveFactor([0, 0, 0]).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(s.orm ? 1 : 0).setRoughnessFactor(s.roughness ?? 1).setDoubleSided(!!s.double)
      if (s.alpha) m.setAlphaMode(s.alpha).setAlphaCutoff(s.cutoff ?? 0.5)
      else m.setAlphaMode('OPAQUE')
      m.setBaseColorTexture(await texture(doc, cache, `${s.base}|${s.overlay ?? ''}|${s.alphaFrom ?? ''}|${s.darken?.file ?? ''}|${s.grade ? 'g' : ''}|${s.underEye ? 'u' : ''}|${size}`, async () => {
        const src = s.overlay ? await sharp(T(s.base)).composite([{ input: T(s.overlay) }]).png().toBuffer() : T(s.base)
        const rgb = await sharp(src).removeAlpha().linear(s.tint ?? [1, 1, 1], [0, 0, 0]).resize(size, size).raw().toBuffer()
        if (s.darken) {
          const d = await channel(s.darken.file, 0, size)
          const k = s.darken.min
          for (let i = 0; i < d.length; i++) {
            const f = k + (1 - k) * (d[i]! / 255)
            for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgb[i * 3 + c]! * f)
          }
        }
        if (s.underEye) {
          const bare = await sharp(T(s.underEye.bare)).removeAlpha().resize(size, size).raw().toBuffer()
          const r = liftUnderEye(rgb, bare, size, s.underEye.k)
          console.log(`${file}: ${m.getName()} under-eye / cheek ${r.before.toFixed(3)} → ${r.after.toFixed(3)}`)
        }
        if (s.grade) {
          const { sat, gain, warm = [1, 1, 1] } = s.grade
          for (let i = 0; i < rgb.length; i += 3) {
            const l = 0.2126 * rgb[i]! + 0.7152 * rgb[i + 1]! + 0.0722 * rgb[i + 2]!
            for (let c = 0; c < 3; c++) rgb[i + c] = Math.max(0, Math.min(255, Math.round((l + (rgb[i + c]! - l) * sat) * gain * warm[c]!)))
          }
        }
        const img = () => sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
        if (s.alphaFrom || s.alpha) {
          const a = await sharp(T(s.alphaFrom ?? s.base)).ensureAlpha().extractChannel(3).resize(size, size).raw().toBuffer()
          return { data: await img().joinChannel(a, { raw: { width: size, height: size, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' }
        }
        return jpeg(img())
      }))
      if (s.normal) {
        m.setNormalTexture(await texture(doc, cache, `${s.normal}|n|${size}`, async () => {
          const raw = await sharp(T(s.normal!)).removeAlpha().resize(size, size).raw().toBuffer({ resolveWithObject: true })
          if (s.normalDx) for (let i = 1; i < raw.data.length; i += 3) raw.data[i] = 255 - raw.data[i]!
          return jpeg(sharp(raw.data, { raw: { width: size, height: size, channels: 3 } }))
        }))
      }
      const orm = s.orm ?? s.mask ?? s.ao
      if (orm) {
        const n = s.ormSize ?? 1024
        const tex = await texture(doc, cache, `${orm}|orm|${n}`, async () => {
          if (s.orm) return jpeg(sharp(T(s.orm)).removeAlpha().resize(n, n)) // R occlusion, G roughness, B metallic: glTF's layout
          const out = Buffer.alloc(n * n * 3)
          if (s.mask) {
            const ao = await channel(s.mask, 1, n), sm = await channel(s.mask, 3, n)
            for (let i = 0; i < n * n; i++) { out[i * 3] = ao[i]!; out[i * 3 + 1] = 255 - sm[i]!; out[i * 3 + 2] = 0 }
          } else {
            const ao = await channel(s.ao!, 0, n)
            for (let i = 0; i < n * n; i++) { out[i * 3] = ao[i]!; out[i * 3 + 1] = 255; out[i * 3 + 2] = 0 }
          }
          return jpeg(sharp(out, { raw: { width: n, height: n, channels: 3 } }))
        })
        m.setMetallicRoughnessTexture(tex)
        m.setOcclusionTexture(tex)
      }
    }
    for (const t of root.listTextures()) if (!t.listParents().some(p => p !== root)) t.dispose()

    // 3. the retarget spec: retail rest (the Chinese man/woman) → this body's own rest
    const retailSide = JSON.parse(readFileSync(join(WORK, `out-opt/char/china/${RETAIL[g]}.json`), 'utf8')) as Record<string, unknown>
    const retailDoc = await io.read(join(WORK, `out/char/china/${RETAIL[g]}.glb`))
    const retailRest = restOf(retailDoc, new Set((retailSide.skeleton as { joints: string[] }).joints))
    const skin = root.listSkins()[0]
    if (!skin) throw new Error(`${file}: no skin`)
    const jointNames = new Set(skin.listJoints().map(j => j.getName()))
    // the skeleton's ancestors must be identity (the Blender script applied the FBX transform)
    for (const j of skin.listJoints()) {
      const p = j.getParentNode()
      if (p && !jointNames.has(p.getName()) && p.getMatrix().some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-5)) throw new Error(`${file}: skeleton ancestor ${p.getName()} is not identity`)
    }
    const targetRest = restOf(doc, jointNames)
    const spec = buildRetargetSpec(retailRest, targetRest)
    // check: the retail rest pose must give the aligned rest back (no drift), hip at rest
    const rt = makeRetargeter(spec)
    const restPose = rt.pose(() => undefined)
    let worst = 0
    for (const j of spec.target) {
      const q = restPose.rot.get(j.name)
      if (!q) continue
      const d = qmul(qinv(j.r), q)
      worst = Math.max(worst, 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3])))
    }
    const hipJ = spec.target.find(j => j.name === spec.hip.target)!
    const hipErr = Math.hypot(...restPose.hip.map((v, i) => v - hipJ.t[i]!))
    if (worst > 1e-4 || hipErr > 1e-4) throw new Error(`${file}: rest round trip off by ${worst} rad / ${hipErr} m`)
    const unmapped = Object.values(spec.map).length

    // 4. the wardrobe (§16.9): the separated pieces and which of them cover each body slice (waterbender-export.py)
    const piecesFile = join(IN, file.replace(/.glb$/, '.pieces.json'))
    const wardrobe = existsSync(piecesFile) ? (JSON.parse(readFileSync(piecesFile, 'utf8')) as { pieces: string[]; slices: Record<string, [number, number][]>; ownerSize: number; owner: string }) : null
    if (wardrobe && !owners.has(g)) owners.set(g, wardrobe)

    // 5. write
    const glb = await io.writeBinary(doc)
    const name = `waterbender_${g}_${variant}`
    const side = {
      ...Object.fromEntries(Object.entries(retailSide).filter(([k]) => ['version', 'type', 'units', 'attachBone', 'animations', 'animationPacks', 'skeleton'].includes(k))),
      name,
      generator: 'licensed-char.ts (CHARACTERS §16)',
      licensed: {
        pack: 'River Spirit Waterbender (IdaFaber, Fab Standard License): not redistributable, never in git',
        gender: g,
        outfit: variant,
        face: FACE[g],
        faces: [FACE[g], ...FACES[g].filter(v => v !== FACE[g])],
        triangles: tris,
        lods: lodTris.slice(1),
        joints: jointNames.size,
        restRoundTrip: worst,
        ...(wardrobe ? { wardrobe: { pieces: wardrobe.pieces, slices: wardrobe.slices, dye: CLOTH_DYE_FILES } } : {}),
      },
      retarget: spec,
    }
    // the other makeup variants as plain head maps (same grade and size as the built-in one)
    const faceJpgs: [string, Buffer][] = []
    // (once per gender: the outfits share the head)
    for (const v of variant === '01' ? FACES[g] : []) {
      const slot = materialMaps(g, v).MAT_HEAD!
      const rgb = await sharp(T(slot.base)).removeAlpha().resize(2048, 2048).raw().toBuffer()
      if (slot.underEye) liftUnderEye(rgb, await sharp(T(slot.underEye.bare)).removeAlpha().resize(2048, 2048).raw().toBuffer(), 2048, slot.underEye.k)
      const { sat, gain, warm = [1, 1, 1] } = slot.grade!
      for (let i = 0; i < rgb.length; i += 3) {
        const l = 0.2126 * rgb[i]! + 0.7152 * rgb[i + 1]! + 0.0722 * rgb[i + 2]!
        for (let c = 0; c < 3; c++) rgb[i + c] = Math.max(0, Math.min(255, Math.round((l + (rgb[i + c]! - l) * sat) * gain * warm[c]!)))
      }
      faceJpgs.push([`${g}_${v}.jpg`, (await jpeg(sharp(rgb, { raw: { width: 2048, height: 2048, channels: 3 } }))).data])
    }
    for (const dir of OUTS) {
      mkdirSync(dir, { recursive: true })
      if (faceJpgs.length) mkdirSync(join(dir, 'faces'), { recursive: true })
      for (const [n, data] of faceJpgs) writeFileSync(join(dir, 'faces', n), data)
      writeFileSync(join(dir, `${name}.glb`), glb)
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(side))
    }
    console.log(`${name}.glb ${wardrobe ? `wardrobe ${wardrobe.pieces.length} pieces, ` : ''}${(glb.byteLength / 1048576).toFixed(1)} MB, ${tris} tris (LOD1 ${lodTris[1]}, LOD2 ${lodTris[2]}), ${jointNames.size} joints, ${unmapped} mapped, hip scale ${spec.hip.scale}, rest round trip ${worst.toExponential(1)}`)
  }
  // the cloth dye maps (§16.9), once per run: shared by both bodies (one clothes UV atlas), the owner map per gender
  if (owners.size) {
    const dye = await clothDyeMaps(sharp, T, [...owners].map(([g, w]) => ({ g, ...w })))
    dye.push(await clothWearMap(sharp, T))
    for (const dir of OUTS) for (const [n, data] of dye) writeFileSync(join(dir, n), data)
    console.log(`cloth dye: ${dye.map(([n, d]) => `${n} ${(d.byteLength / 1024).toFixed(0)} kB`).join(', ')}`)
  }
}

// run as a CLI only (licensed-creator.ts imports the material helpers)
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
