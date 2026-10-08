// The character look drawn on the licensed Waterbender bodies (docs/CHARACTERS.md §16.10): makeup, iris, hairstyle and
// hair colour, skin tone, the body paint, accessories and the build, from the look record every client receives
// (packages/shared/src/look.ts; EntityState.look, CharacterSummary.look). The creator edits a look and calls the same
// apply on its preview.
//
// - Materials: the glb's materials are shared by every body of the file; a look that differs from the file's own takes
//   per-look copies (cached by look key, shared by every body with the same key, released with the last one). LOD2 keeps
//   the file's materials (the crowd tier's atlas draws far bodies; a slot per look would not fit).
// - Textures (work/out/char/licensed/waterbender/look/, licensed-creator.ts): the head makeup maps (2048 for the own
//   character, 1024 for everyone else and the creator's browsing), the irises, the white hair for the recolour, the body
//   albedo and paint mask (the paint is drawn into a canvas once per body and colour).
// - Parts: hairstyles and accessories missing from the body's glb come from `waterbender_<g>_parts.glb` (same joint
//   list, checked by the converter and again here) and are bound to the body's skeleton; parts the look does not want
//   are hidden (`isVisible`, so the LOD switch, the merges and the crowd leave them out). The face shape is never touched.
// - Build: girth-only bone scales (across the bone, Y/Z; X runs along it) within safe limits (never the face, hands or
//   feet), relative to the body's default build, so a default look is exactly the artist's shape and the build never
//   changes the height. Height is only the root scale (heightScale).
// Without the look files (an older converter output) the look's materials quietly keep the file's own.
import {
  Color3,
  DynamicTexture,
  LoadAssetContainerAsync,
  Mesh,
  PBRMaterial,
  Texture,
  type AbstractMesh,
  type AssetContainer,
  type Material,
  type Scene,
  type TransformNode,
} from '@babylonjs/core'
import { LOOK_BUILD_DEFAULT, LOOK_HAIR_COLORS, LOOK_HAIRS, LOOK_IRIS_DEFAULT, LOOK_MAKEUP_DEFAULT, LOOK_PAINTS, lookSkinMultiplier, type CharLook, type LookBody, type LookBuild } from '@sro/shared'
import { attachCharPhysics } from './char-physics.ts'
import { cloneUndecorated, licensedLodOf, licensedMaterialRole, retuneLicensedMaterial, TEXTURE_ANISOTROPY, tuneLicensedMaterials } from './licensed-materials.ts'
import type { CharacterActor } from './models.ts'

export const LOOK_ROOT = '/out/char/licensed/waterbender'

// ---- pure: parts, build, material plan ----------------------------------------------------------------------------

const G = (b: LookBody) => (b === 'f' ? 'F' : 'M')
/** The pack's mesh names of a hairstyle (style + bangs). */
export function hairPartNames(body: LookBody, hair: string): string[] {
  const h = LOOK_HAIRS[body][hair] ?? LOOK_HAIRS[body]['01']!
  const out = [`SK_RIVERSPIRIT_${G(body)}_HAIR_0${h.style}`]
  if (h.bangs) out.push(body === 'f' ? 'SK_RIVERSPIRIT_F_HAIR_01_Bangs' : 'SK_RIVERSPIRIT_M_HAIR_01_BANGS')
  return out
}
/** Accessory id → the pack's mesh (girl). */
export const ACCESSORY_PARTS: Readonly<Record<string, string>> = { earrings: 'SK_RIVERSPIRIT_F_EARRINGS', hair_flower: 'SK_RIVERSPIRIT_F_HAIR_FLOWER', nails: 'SK_RIVERSPIRIT_F_NAILS' }
const PART_OF_ACCESSORY = new Map(Object.entries(ACCESSORY_PARTS).map(([k, v]) => [v, k]))

/** A mesh's part name: without the LOD suffix (`__LOD1`), the glTF primitive suffix and the soft hair pass. */
export function partBaseName(name: string): string {
  return name.replace(/_soft$/, '').replace(/_primitive\d+$/, '').replace(/__LOD\d$/, '')
}

/** What a mesh is to the look: a hair piece, an accessory, or neither (body, head, clothes). */
export function lookPartOf(name: string): { kind: 'hair'; name: string } | { kind: 'accessory'; id: string; name: string } | null {
  const base = partBaseName(name)
  const acc = PART_OF_ACCESSORY.get(base)
  if (acc) return { kind: 'accessory', id: acc, name: base }
  if (/^SK_RIVERSPIRIT_[FM]_HAIR_0\d(_BANGS)?$/i.test(base)) return { kind: 'hair', name: base }
  return null
}

/** The part names a look shows (hair pieces and accessories). */
export function lookPartNames(look: CharLook): Set<string> {
  const s = new Set(hairPartNames(look.body, look.hair))
  for (const a of look.accessories) if (ACCESSORY_PARTS[a] && look.body === 'f') s.add(ACCESSORY_PARTS[a]!)
  return s
}

/**
 * The build's bone girths (CHARACTERS §16.10): wanted scale per bone, relative to the body's default build (the default
 * look is the artist's shape). The pack's joints are Unreal's: local **X runs along the bone** (spine and pelvis X point
 * up, the legs' down, the clavicles' and arms' outwards), so a girth is Y and Z, never X: scaling X lengthened the spine
 * and legs, so the weight slider changed the height. Shoulder width is the clavicles' length (X: the arms move out, not
 * up), hip width the pelvis's Z (sideways). Nothing along a vertical bone is scaled: the build never changes the height
 * (that is the root scale, heightScale). Safe limits: at most ±7 % girth, ±5 % shoulder width; the head, neck top,
 * hands and feet are never scaled (their parents' scale is undone below them).
 */
export const BUILD_LIMITS = { weight: 0.07, muscle: 0.06, shoulders: 0.05, chest: 0.12, hips: 0.05 } as const
export function lookBoneTargets(body: LookBody, build: LookBuild): Map<string, [number, number, number]> {
  const d = LOOK_BUILD_DEFAULT[body]
  const t = (k: keyof LookBuild) => Math.max(-1, Math.min(1, (build[k] - d[k]) / 50))
  const w = t('weight') * BUILD_LIMITS.weight, mu = t('muscle') * BUILD_LIMITS.muscle
  const out = new Map<string, [number, number, number]>()
  const mul = (bone: string, x: number, y: number, z: number) => {
    if (Math.abs(x - 1) < 1e-4 && Math.abs(y - 1) < 1e-4 && Math.abs(z - 1) < 1e-4) return
    const cur = out.get(bone) ?? [1, 1, 1]
    out.set(bone, [cur[0] * x, cur[1] * y, cur[2] * z])
  }
  /** Across the bone (Y, Z), never along it (X). */
  const girth = (bone: string, g: number) => mul(bone, 1, 1 + g, 1 + g)
  for (const s of ['spine_01', 'spine_02', 'spine_03']) girth(s, w)
  girth('pelvis', w * 0.6)
  for (const side of ['l', 'r']) {
    girth(`thigh_${side}`, w + mu * 0.4)
    girth(`calf_${side}`, w * 0.6 + mu * 0.4)
    girth(`upperarm_${side}`, w * 0.8 + mu)
    girth(`lowerarm_${side}`, w * 0.5 + mu * 0.8)
  }
  const sh = t('shoulders') * BUILD_LIMITS.shoulders
  for (const side of ['l', 'r']) mul(`clavicle_${side}`, 1 + sh, 1, 1)
  mul('pelvis', 1, 1, 1 + t('hips') * BUILD_LIMITS.hips)
  const chest = t('chest') * BUILD_LIMITS.chest
  if (body === 'f') for (const side of ['l', 'r']) mul(`breast_${side}`, 1 + chest, 1 + chest, 1 + chest)
  else girth('spine_04', chest * 0.3)
  return out
}

/**
 * The local scale each joint needs so the wanted (inherited) scales land: local = wanted / parent's wanted, per axis
 * (the chain's bones run near the same axes, so the ratio is close). Joints not wanted but under a scaled parent get its
 * inverse: hands, feet, head and the rest keep their size. Joints at 1 under an unscaled parent are left out.
 */
export function localBoneScales(targets: ReadonlyMap<string, readonly [number, number, number]>, parentOf: (bone: string) => string | null, bones: Iterable<string>): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>()
  for (const b of bones) {
    const want = targets.get(b) ?? [1, 1, 1]
    const p = parentOf(b)
    const pw = (p && targets.get(p)) || [1, 1, 1]
    const l: [number, number, number] = [want[0] / pw[0], want[1] / pw[1], want[2] / pw[2]]
    if (l.some(v => Math.abs(v - 1) > 1e-5)) out.set(b, l)
  }
  return out
}

/** sRGB hex → linear RGB. */
export function hexLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
}

/** The looks' material changes, per role. Empty strings / nulls = the file's own. */
export interface LookMaterialPlan {
  head: { makeup: string | null; tint: [number, number, number] | null }
  body: { paint: string | null; tint: [number, number, number] | null }
  eye: { iris: string | null }
  hair: { color: [number, number, number] | null }
}
/**
 * What the materials need for a look. `builtIn`: the file's own makeup and iris (the sidecar's `licensed.face`, the
 * body's default iris). Hair colour: the white map × the palette colour (linear), lifted 1.6× (the white map's mean is ≈ 0.6).
 */
export function lookMaterialPlan(look: CharLook, builtIn: { makeup: string; iris: string }): LookMaterialPlan {
  const tone = look.skinTone > 0 || look.skinShift !== 0 ? lookSkinMultiplier(look.skinTone, look.skinShift) : null
  const paint = look.markings.find(m => LOOK_PAINTS[m]) ?? null
  const hc = look.hairColor > 0 ? LOOK_HAIR_COLORS[look.hairColor - 1] : undefined
  return {
    head: { makeup: look.makeup !== builtIn.makeup ? look.makeup : null, tint: tone },
    body: { paint, tint: tone },
    eye: { iris: look.iris !== builtIn.iris ? look.iris : null },
    hair: { color: hc ? (hexLinear(hc).map(c => Math.min(1.6, c * 1.6)) as [number, number, number]) : null },
  }
}

type Slot = 'head' | 'body' | 'eye' | 'hair' | null
/** The look slot of a licensed material name ('MAT_HEAD', 'MAT_HAIR_soft', ...). */
export function lookSlotOf(name: string): Slot {
  const n = name.replace(/_soft$/, '')
  if (n === 'MAT_HEAD') return 'head'
  if (n === 'MAT_BODY') return 'body'
  const role = licensedMaterialRole(n)
  return role === 'eye' ? 'eye' : role === 'hair' ? 'hair' : null
}

/** The variant key of a slot under a plan ('' = the file's own material). `hi`: the 2048 head map. */
export function slotKey(slot: Slot, p: LookMaterialPlan, hi: boolean): string {
  const t = (v: [number, number, number] | null) => (v ? v.map(x => x.toFixed(3)).join(',') : '')
  switch (slot) {
    case 'head':
      return p.head.makeup || p.head.tint ? `head:${p.head.makeup ?? ''}${p.head.makeup && hi ? '@2k' : ''}:${t(p.head.tint)}` : ''
    case 'body':
      return p.body.paint || p.body.tint ? `body:${p.body.paint ?? ''}:${t(p.body.tint)}` : ''
    case 'eye':
      return p.eye.iris ? `eye:${p.eye.iris}` : ''
    case 'hair':
      return p.hair.color ? `hair:${t(p.hair.color)}` : ''
    default:
      return ''
  }
}

// ---- the look files --------------------------------------------------------------------------------------------------

export interface LookIndex {
  version: 1
  makeups: Record<LookBody, string[]>
  irises: string[]
  hair: boolean
  paint: boolean
  parts: boolean
}
let indexP: Promise<LookIndex | null> | null = null
/** The look files' index (null: not built here; the looks then draw the files' own materials). Once per page. */
export function lookIndex(fetchFn: typeof fetch = fetch): Promise<LookIndex | null> {
  if (!indexP) {
    indexP = (async () => {
      try {
        const r = await fetchFn(`${LOOK_ROOT}/look/index.json`)
        if (!r.ok) return null
        const j = (await r.json()) as LookIndex
        return j?.version === 1 ? j : null
      } catch {
        return null
      }
    })()
  }
  return indexP
}
/** Test hook. */
export function resetLookIndex(): void {
  indexP = null
}

export const lookUrls = {
  face: (b: LookBody, v: string, hi: boolean) => `${LOOK_ROOT}/look/${b}/face${hi ? '' : '1k'}_${v}.jpg`,
  faceThumb: (b: LookBody, v: string) => `${LOOK_ROOT}/look/${b}/facethumb_${v}.jpg`,
  eye: (v: string) => `${LOOK_ROOT}/look/eye_${v}.jpg`,
  eyeThumb: (v: string) => `${LOOK_ROOT}/look/eyethumb_${v}.jpg`,
  hairWhite: (b: LookBody) => `${LOOK_ROOT}/look/${b}/hair_white.png`,
  body: (b: LookBody) => `${LOOK_ROOT}/look/${b}/body.jpg`,
  paint: (b: LookBody) => `${LOOK_ROOT}/look/${b}/paint.png`,
  parts: (b: LookBody) => `${LOOK_ROOT}/waterbender_${b}_parts.glb`,
  base: (b: LookBody) => `${LOOK_ROOT}/waterbender_${b}_base`,
}

// ---- Babylon: textures and material variants (shared per scene) --------------------------------------------------------

interface Shared {
  tex: Map<string, { t: Promise<Texture | null>; refs: number }>
  mats: Map<string, { mat: Promise<PBRMaterial | null>; refs: number; texKey: string | null }>
  parts: Map<string, Promise<AssetContainer | null>>
}
const sharedOf = new WeakMap<Scene, Shared>()
function shared(scene: Scene): Shared {
  let s = sharedOf.get(scene)
  if (!s) {
    s = { tex: new Map(), mats: new Map(), parts: new Map() }
    sharedOf.set(scene, s)
    scene.onDisposeObservable.addOnce(() => sharedOf.delete(scene))
  }
  return s
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image ${url}`))
    img.src = url
  })
}

/** The body albedo with the paint drawn over in its colour (one canvas per body and colour). */
async function paintTexture(scene: Scene, body: LookBody, paint: string): Promise<Texture | null> {
  const [alb, mask] = await Promise.all([loadImage(lookUrls.body(body)), loadImage(lookUrls.paint(body))])
  const n = alb.width
  const dt = new DynamicTexture(`look_paint_${body}_${paint}`, { width: n, height: n }, scene, true)
  const ctx = dt.getContext() as unknown as CanvasRenderingContext2D
  ctx.drawImage(alb, 0, 0, n, n)
  const layer = document.createElement('canvas')
  layer.width = layer.height = n
  const lc = layer.getContext('2d')!
  lc.drawImage(mask, 0, 0, n, n)
  lc.globalCompositeOperation = 'source-in'
  lc.fillStyle = LOOK_PAINTS[paint] ?? '#ffffff'
  lc.fillRect(0, 0, n, n)
  ctx.globalAlpha = 0.82
  ctx.drawImage(layer, 0, 0)
  ctx.globalAlpha = 1
  dt.update(false)
  dt.wrapU = dt.wrapV = Texture.WRAP_ADDRESSMODE
  return dt
}

function acquireTexture(scene: Scene, key: string, make: () => Promise<Texture | null>): Promise<Texture | null> {
  const s = shared(scene)
  let e = s.tex.get(key)
  if (!e) {
    e = { t: make().catch(err => (console.warn('[look] texture failed', key, err), null)), refs: 0 }
    s.tex.set(key, e)
  }
  e.refs++
  return e.t
}

function releaseTexture(scene: Scene, key: string): void {
  const s = shared(scene)
  const e = s.tex.get(key)
  if (!e || --e.refs > 0) return
  s.tex.delete(key)
  void e.t.then(t => t?.dispose())
}

function urlTexture(scene: Scene, url: string, alpha = false): Promise<Texture | null> {
  return new Promise(resolve => {
    const t = new Texture(url, scene, {
      invertY: false,
      onLoad: () => {
        t.anisotropicFilteringLevel = TEXTURE_ANISOTROPY
        t.hasAlpha = alpha
        resolve(t)
      },
      onError: () => {
        t.dispose()
        resolve(null)
      },
    })
  })
}

/** The texture a slot's variant draws (null: keep the file's albedo, only the tint changes). */
function variantTexture(scene: Scene, body: LookBody, slot: Slot, p: LookMaterialPlan, hi: boolean): { key: string; make: () => Promise<Texture | null> } | null {
  if (slot === 'head' && p.head.makeup) {
    const url = lookUrls.face(body, p.head.makeup, hi)
    return { key: url, make: () => urlTexture(scene, url) }
  }
  if (slot === 'body' && p.body.paint) return { key: `paint:${body}:${p.body.paint}`, make: () => paintTexture(scene, body, p.body.paint!) }
  if (slot === 'eye' && p.eye.iris) {
    const url = lookUrls.eye(p.eye.iris)
    return { key: url, make: () => urlTexture(scene, url) }
  }
  if (slot === 'hair' && p.hair.color) {
    const url = lookUrls.hairWhite(body)
    return { key: url, make: () => urlTexture(scene, url, true) }
  }
  return null
}

/** The file material's own intensities and environment, taken the first time a look sees it (before any trim). */
const pristine = new WeakMap<PBRMaterial, { d: number; e: number }>()

function acquireMaterial(orig: PBRMaterial, key: string, body: LookBody, slot: Slot, p: LookMaterialPlan, hi: boolean, decorate?: (m: Material) => void): Promise<PBRMaterial | null> {
  const scene = orig.getScene()
  const s = shared(scene)
  const k = `${orig.uniqueId}|${key}`
  let e = s.mats.get(k)
  if (!e) {
    const vt = variantTexture(scene, body, slot, p, hi)
    const mat = (async () => {
      const tex = vt ? await acquireTexture(scene, vt.key, vt.make) : null
      if (vt && !tex) return null
      const m = cloneUndecorated(orig, orig.name)
      const pr = pristine.get(orig)
      if (pr) {
        m.directIntensity = pr.d
        m.environmentIntensity = pr.e
      }
      m.reflectionTexture = null
      m.metadata = { ...(orig.metadata as object | null), sroLook: key }
      if (!/_soft$/.test(orig.name)) retuneLicensedMaterial(m)
      decorate?.(m)
      if (tex) {
        const old = orig.albedoTexture as Texture | null
        if (old) tex.coordinatesIndex = old.coordinatesIndex
        m.albedoTexture = tex
      }
      const tint = slot === 'head' ? p.head.tint : slot === 'body' ? p.body.tint : slot === 'hair' ? p.hair.color : null
      if (tint) m.albedoColor = new Color3(...tint)
      return m
    })()
    e = { mat, refs: 0, texKey: vt?.key ?? null }
    s.mats.set(k, e)
  }
  e.refs++
  return e.mat
}

function releaseMaterial(orig: PBRMaterial, key: string): void {
  const scene = orig.getScene()
  const s = shared(scene)
  const k = `${orig.uniqueId}|${key}`
  const e = s.mats.get(k)
  if (!e || --e.refs > 0) return
  s.mats.delete(k)
  void e.mat.then(m => {
    // a body may still draw it for a frame: dispose after the swap
    m?.dispose(false, false)
    if (e.texKey) releaseTexture(scene, e.texKey)
  })
}

// ---- per actor ----------------------------------------------------------------------------------------------------------

interface ActorLook {
  /** Per mesh: the file's material and the variant key it draws now. */
  mats: Map<AbstractMesh, { orig: PBRMaterial; key: string }>
  /** Parts bound from the parts glb, by part name. */
  attached: Map<string, AbstractMesh[]>
  scaled: Set<TransformNode>
  /** The last applied look (JSON) and the pending apply. */
  applied: string
  seq: number
}
const state = new WeakMap<CharacterActor, ActorLook>()

export interface ApplyLookOptions {
  /** The 2048 head map (the own character); else 1024. */
  hi?: boolean
  /** The library's material decorator (the world's surface plugin). */
  decorate?: (m: Material) => void
  /** The file's own makeup (the sidecar's `licensed.face`); default the body's. */
  builtInMakeup?: string
}

function partsContainer(scene: Scene, body: LookBody): Promise<AssetContainer | null> {
  const s = shared(scene)
  const url = lookUrls.parts(body)
  let p = s.parts.get(url)
  if (!p) {
    p = LoadAssetContainerAsync(url, scene, { pluginOptions: { gltf: { animationStartMode: 0 } } }).catch(err => {
      console.warn('[look] parts glb failed', url, err)
      return null
    })
    s.parts.set(url, p)
  }
  return p
}

/** Binds the parts glb's meshes named `names` (every LOD) to the actor's skeleton. Returns them by part name. */
async function attachParts(actor: CharacterActor, body: LookBody, names: string[], decorate?: (m: Material) => void): Promise<Map<string, AbstractMesh[]>> {
  const out = new Map<string, AbstractMesh[]>()
  const skel = actor.skeleton
  if (!skel || !names.length) return out
  const c = await partsContainer(actor.scene, body)
  if (!c || actor.isDisposed) return out
  const inst = c.instantiateModelsToScene(n => n, false, { doNotInstantiate: true })
  const theirs = inst.skeletons[0]
  const ok = !!theirs && theirs.bones.length === skel.bones.length && theirs.bones.every((b, i) => b.name === skel.bones[i]!.name)
  const take: AbstractMesh[] = []
  if (ok) {
    for (const r of inst.rootNodes)
      for (const m of r.getChildMeshes(false)) {
        const base = partBaseName(m.name)
        if (!names.includes(base) || m.getTotalVertices() <= 0) continue
        take.push(m)
        out.set(base, [...(out.get(base) ?? []), m])
      }
    // the same parent as the body's parts (the glTF root under the actor, same handedness transform)
    const anchor = actor.meshes.find(m => m.skeleton === skel && m.getTotalVertices() > 0)?.parent ?? actor.root
    for (const m of take) {
      m.parent = anchor
      ;(m as Mesh).skeleton = skel
      m.alwaysSelectAsActiveMesh = true
      m.isPickable = false
    }
  } else console.warn('[look] parts skeleton differs from the body: parts skipped')
  for (const r of inst.rootNodes) r.dispose(false, false)
  for (const s of inst.skeletons) s.dispose()
  for (const g of inst.animationGroups) g.dispose()
  if (!take.length) return out
  tuneLicensedMaterials(take, decorate)
  actor.addLicensedParts(take)
  return out
}

/**
 * Draws `look` on a licensed actor (idempotent; the last call wins). Safe on a retail actor (no-op) and without the
 * look files (the materials stay the file's).
 */
const lastLook = new WeakMap<CharacterActor, { look: CharLook; opts: ApplyLookOptions }>()

/** Draws the actor's last look again (a worn earring came or went: its part shows or hides). No-op before any look. */
export function refreshLicensedLook(actor: CharacterActor): Promise<void> {
  const l = lastLook.get(actor)
  return l ? applyLicensedLook(actor, l.look, l.opts) : Promise.resolve()
}

export async function applyLicensedLook(actor: CharacterActor, look: CharLook, opts: ApplyLookOptions = {}): Promise<void> {
  if (actor.isDisposed || !actor.skeleton) return
  let st = state.get(actor)
  // the last look and options (refreshLicensedLook: a worn earring changed)
  lastLook.set(actor, { look, opts })
  if (!st) {
    st = { mats: new Map(), attached: new Map(), scaled: new Set(), applied: '', seq: 0 }
    state.set(actor, st)
    const s = st
    actor.root.onDisposeObservable.addOnce(() => {
      for (const { orig, key } of s.mats.values()) if (key) releaseMaterial(orig, key)
      s.mats.clear()
    })
  }
  const earring = actor.earringWorn && look.body === 'f'
  const json = JSON.stringify([look, !!opts.hi, earring])
  if (json === st.applied) return
  st.applied = json
  const seq = ++st.seq
  const body = look.body
  const index = await lookIndex()
  if (actor.isDisposed || seq !== st.seq) return

  // 1. parts: the wanted hair and accessories shown (bound from the parts glb when the file lacks them), the rest hidden
  const want = lookPartNames(look)
  // a worn earring item shows the earrings whatever the look's accessories say (§16.9; the girl only)
  actor.lookEarrings = want.has(ACCESSORY_PARTS.earrings!)
  if (earring) want.add(ACCESSORY_PARTS.earrings!)
  const attachedMeshes = new Set([...st.attached.values()].flat())
  const present = new Set<string>()
  for (const m of actor.meshes) {
    const p = lookPartOf(m.name)
    if (p && !attachedMeshes.has(m) && licensedLodOf(m) === 0 && m.getTotalVertices() > 0) present.add(p.name)
  }
  // the file's own hair: kept as a whole when the look's hair is exactly that hair (its joined LOD1 / LOD2 copy too);
  // otherwise every wanted hair piece comes from the parts glb (with its own lower LODs)
  const isHair = (n: string) => lookPartOf(n)?.kind === 'hair'
  const fileHair = [...present].filter(isHair)
  const wantHair = [...want].filter(isHair)
  const sameHair = fileHair.length === wantHair.length && fileHair.every(n => want.has(n))
  const missing = [...want].filter(n => !st!.attached.has(n) && (isHair(n) ? !sameHair : !present.has(n)))
  if (missing.length && index?.parts) {
    const got = await attachParts(actor, body, missing, opts.decorate)
    if (actor.isDisposed) return
    for (const [k, v] of got) {
      st.attached.set(k, v)
      for (const m of v) attachedMeshes.add(m)
    }
  }
  const shownBefore = actor.meshes.filter(m => m.isVisible && lookPartOf(m.name)?.kind === 'hair').map(m => m.uniqueId).join(',')
  for (const m of actor.meshes) {
    const p = lookPartOf(m.name)
    let show: boolean | null = null
    if (p?.kind === 'hair') show = want.has(p.name) && (attachedMeshes.has(m) ? !sameHair : sameHair)
    else if (p) show = want.has(p.name)
    // the joined lower-LOD body (SK_WATERBENDER__LOD1 / 2): its hair primitive is the file's hair
    else if (/^SK_WATERBENDER__LOD/.test(m.name) && m.material && lookSlotOf(m.material.name) === 'hair') show = sameHair
    if (show === null) continue
    m.isVisible = show
    for (const c of m.getChildMeshes(true)) c.isVisible = show // the soft hair pass hangs under its core
  }
  const hairChanged = shownBefore !== actor.meshes.filter(m => m.isVisible && lookPartOf(m.name)?.kind === 'hair').map(m => m.uniqueId).join(',')

  // 2. materials (LOD0 and LOD1; LOD2 keeps the file's, the crowd's atlas)
  const builtIn = { makeup: opts.builtInMakeup ?? LOOK_MAKEUP_DEFAULT[body], iris: LOOK_IRIS_DEFAULT[body] }
  const plan = lookMaterialPlan(look, builtIn)
  if (!index?.makeups[body]?.includes(look.makeup)) plan.head.makeup = null
  if (!index?.paint) plan.body.paint = null
  if (!index?.hair) plan.hair.color = null
  if (!index) plan.eye.iris = null
  const jobs: Promise<void>[] = []
  // the parts and the soft hair passes hanging under their cores (not in actor.meshes)
  const drawn = actor.meshes.flatMap(m => [m, ...m.getChildMeshes(true).filter(c => /_soft$/.test(c.name))])
  for (const m of drawn) {
    const cur = st.mats.get(m)
    const mat = m.material
    const orig = cur?.orig ?? (mat instanceof PBRMaterial ? mat : null)
    if (!orig) continue
    const slot = lookSlotOf(orig.name)
    if (!slot) continue
    if (!pristine.has(orig)) pristine.set(orig, { d: orig.directIntensity, e: orig.environmentIntensity })
    const key = licensedLodOf(m) >= 2 ? '' : slotKey(slot, plan, !!opts.hi)
    if ((cur?.key ?? '') === key) continue
    const prevKey = cur?.key ?? ''
    st.mats.set(m, { orig, key })
    if (!key) {
      m.material = orig
      if (prevKey) releaseMaterial(orig, prevKey)
      continue
    }
    jobs.push(
      acquireMaterial(orig, key, body, slot, plan, !!opts.hi, opts.decorate).then(v => {
        const now = st!.mats.get(m)
        if (now?.key !== key || m.isDisposed()) return releaseMaterial(orig, key)
        m.material = v ?? orig
        if (prevKey) releaseMaterial(orig, prevKey)
      }),
    )
  }
  await Promise.all(jobs)
  if (actor.isDisposed || seq !== st.seq) return

  // 3. build: girth-only bone scales
  const skel = actor.skeleton
  const targets = lookBoneTargets(body, look.build)
  const nodes = new Map<string, TransformNode>()
  const parent = new Map<string, string | null>()
  for (const b of skel.bones) {
    const n = b.getTransformNode()
    if (!n) continue
    nodes.set(n.name, n)
    parent.set(n.name, b.getParent()?.getTransformNode()?.name ?? null)
  }
  const local = localBoneScales(targets, b => parent.get(b) ?? null, nodes.keys())
  for (const n of st.scaled) if (!local.has(n.name)) n.scaling.setAll(1)
  st.scaled.clear()
  for (const [name, s] of local) {
    const n = nodes.get(name)!
    n.scaling.set(s[0], s[1], s[2])
    st.scaled.add(n)
  }

  // 4. the springs follow the shown hair; the body jiggle the chest
  if (hairChanged) {
    actor.physics?.dispose()
    actor.physics = attachCharPhysics(actor.scene, actor.root, skel, actor.meshes.filter(m => m.isVisible))
  }
  actor.physics?.setBody(Math.max(0, Math.min(2, 1 + (look.build.chest - LOOK_BUILD_DEFAULT[body].chest) / 50)), 0)
  actor.lookChanged()
}
