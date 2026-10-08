/**
 * The crowd tier (docs/CHARACTERS.md §3.5, P1a; CHAR_PERF.md §2.3's T2 on today's retail characters): an other
 * character in a crowd outside the close set is drawn by ONE thin instance of its outfit batch, skinned from a baked
 * animation texture, with no skeleton, no animation evaluation and no mesh of its own in the frame.
 *
 * - **The VAT** (`VatKind`, one per skeleton signature: the bones' inverse binds, the parts' transform, the Volume skin):
 *   Babylon's BakedVertexAnimationManager layout (one row per frame, 4 half-float texels per bone: the bone's skin
 *   matrix × the part's transform to the actor root), baked IN THE PAGE from the actor's own clips at CROWD_ROWS_PER_S,
 *   lazily, clip by clip as the crowd plays them (a join bakes its current clip at once, later clips within a small
 *   budget per frame), so the 13 men's bodies share one texture and the 13 women's another. Rows grow by powers of two
 *   up to MAX_ROWS.
 * - **The batch** (`CrowdBatch`, one per outfit: the same parts, textures and items): body, armour and hair (skinned)
 *   and weapon and shield (rigid: each vertex moved into its socket bone's skin space and bound to that bone alone) in
 *   one mesh whose albedo is an outfit atlas (three/outfit-merge.ts, a crowd variant that wraps), drawn for everyone
 *   wearing the outfit as thin instances: the root matrix, the VAT settings, the item codes. A part the atlas cannot take
 *   (a blended material, tiling UVs) gets a mesh of its own in the batch with its own material. Monsters and NPCs whose
 *   parts share one material keep it (no atlas): twenty Mangnyang are one draw.
 * - **The far weapon look** (`CrowdItemPlugin` on the crowd atlas materials): the + level's glow (WEAPON_GLOW_TIERS) and
 *   the seal's tint and rim (RARITY_LOOKS) as a per-instance code; the vertex shader moves an item's atlas u by twice
 *   its code (the atlas repeats, so the texel is the same) and the fragment reads it back: no varying (the 16-varying
 *   adapters, gpu-guards.ts), no draw.
 * - **The clip clock**: the actor's clips still run (they fire the game's end events), stepped at CROWD_STEP_HZ (the
 *   crowd budget's rate floor); the tier reads the clip that shows and its frame and extrapolates between steps. A loop
 *   advances on the GPU (its settings do not change while it plays), a one-shot gets its row from the CPU each frame
 *   (three/crowd-vat.ts). The bones the effects read (`joint()`, the trail dummies) keep their 5 Hz pose; the weapon
 *   meshes of a rare item follow the instance exactly (their world matrix from the VAT row), for the seal effects.
 * - **No shadow of its own** (the batch is no caster): the crowd budget gives a crowd member a blob.
 */
import {
  BakedVertexAnimationManager,
  Bone,
  Color4,
  Constants,
  MaterialPluginBase,
  Matrix,
  Mesh,
  PBRMaterial,
  RawTexture,
  RenderTargetTexture,
  ShaderLanguage,
  Skeleton,
  Vector3,
  VertexBuffer,
  VertexData,
  type AbstractEngine,
  type AbstractMesh,
  type Animation,
  type AnimationGroup,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type TransformNode,
  type UniformBuffer,
} from '@babylonjs/core'
import type { RarityTier } from '@sro/shared'
import { sceneExposure } from '@sro/world-render'
import {
  CLOCK_BASE_S,
  CLOCK_REBASE_S,
  CROWD_ROWS_PER_S,
  RARE_TIERS,
  clipTimeAt,
  crowdDrawn,
  halves,
  rowTime,
  rowsFor,
  vatSettings,
  wantedRow,
  type ClipClock,
  type VatRows,
} from './crowd-vat.ts'
import { ATLAS_PAD, atlasSizeOf, packAtlas, remapUV, uvFits } from './outfit-atlas.ts'
import { outfitPartOf, type OutfitAtlases, type OutfitPart } from './outfit-merge.ts'
import { RARITY_LOOKS } from './weapon-rarity.ts'
import { SHIELD_STRENGTH, WEAPON_GLOW_TIERS, exposureScale } from './weapon-glow.ts'

/** Rows a VAT may hold (its texture height; WebGL2 guarantees 2,048, every target here does 4,096+). */
export const MAX_ROWS = 4096
/** The first texture holds this many rows (it doubles as clips are baked). */
export const FIRST_ROWS = 256
/** Baking new clips takes at most this long per frame (ms; at least one clip a frame while any waits). */
export const BAKE_BUDGET_MS = 3
/** A VAT texture is uploaded at most this often (ms) while clips are being baked (a whole-texture upload each). */
export const UPLOAD_EVERY_MS = 200
/** A batch nobody uses for this long is freed (ms); a VAT a little later. */
export const BATCH_EVICT_MS = 30_000
export const KIND_EVICT_MS = 60_000
/** A clip read this far (s) from where the clock put it is a seek: the clock takes the clip's own time again. */
export const RESYNC_S = 1.5 / CROWD_ROWS_PER_S
/**
 * The crowd's own atlas materials are frozen once drawn (Babylon then skips the PBR define check of every draw, ≈ 6 %
 * of the profiled frame) and thawed for one frame this often (ms), so a preset, light or fog change reaches them.
 */
export const THAW_EVERY_MS = 2000
/** A batch mesh draws this many frames before its material is frozen (its effect is compiled by then). */
export const FREEZE_AFTER_FRAMES = 30
/**
 * The crowd's atlas pages: each outfit's textures packed into one SLOT_SIZE² slot (the P0 outfit atlas's size) of a
 * PAGE_SIZE² page, and every batch of one VAT on one page draws with the page's ONE material. Babylon sorts opaque
 * draws by material, and a frozen material skips its whole rebind (uniforms, lights, the VAT) on the next draw with
 * it, so the page's batches cost little more than their vertex buffers each.
 */
export const PAGE_SIZE = 2048
export const SLOT_SIZE = 512
export const PAGE_SLOTS = (PAGE_SIZE / SLOT_SIZE) ** 2
/** A slot's copy is made again this many frames after the first (CrowdTier.recopy). */
export const RECOPY_FRAMES = [3, 60]

/** What the tier needs of a character (CharacterActor). */
export interface CrowdSubject {
  readonly root: TransformNode
  readonly skeleton: Skeleton | null
  readonly isOffscreen: boolean
  readonly isDisposed: boolean
  /** The clip that shows now (the action or skill phase, the base clip, the death clip); null: none. */
  crowdTop(): AnimationGroup | null
  /** The far look of the weapon (low byte) and the shield (next byte): crowd-vat.ts itemCode each. */
  crowdItems(): number
  /** A seal or a +7 glow on the weapon or the shield: their meshes follow the instance (the effects read them). */
  crowdRare(): boolean
  /** A key of the skin beyond the skeleton (the Volume step): different skins do not share a VAT. */
  readonly crowdSkinKey: string
  /** The tier evaluated clips on this character's joints (a bake): its pose must be evaluated again. */
  crowdPoseTouched(): void
}

/** A drawn part: skinned on the subject's skeleton, or rigid on a socket bone (a weapon or shield: ITEM_*). */
export interface CrowdPart {
  mesh: Mesh
  socket: { bone: Bone; item: number } | null
}

/** One character in the tier (CrowdTier.join; the actor keeps it). */
export interface CrowdMember {
  readonly subject: CrowdSubject
  readonly batch: CrowdBatch
  /** The meshes of the subject the batch draws (they are hidden while the member lives). */
  readonly parts: readonly Mesh[]
  /** The skinned part the VAT is baked against. */
  readonly ref: Mesh
  clock: ClipClock | null
  clipKey: string
  group: AnimationGroup | null
  master: number
  speed: number
  /** The rigid parts' meshes and their transform into the socket bone's VAT matrix (rare items follow the instance). */
  readonly rigid: { mesh: Mesh; col: number; c: Matrix; world: Matrix }[]
  frozen: boolean
  left: boolean
}

/** Babylon's internal bone index (the column of a bone in the skin matrices). */
function boneColumn(skeleton: Skeleton, bone: Bone): number {
  const idx = (bone as unknown as { _index: number | null })._index
  return idx === null || idx === undefined ? skeleton.bones.indexOf(bone) : idx
}

const animIds = new WeakMap<Animation, number>()
let animSerial = 0
/** A clip's identity across actors: its name and its first animation (the packs share their Animation objects). */
export function clipKeyOf(g: AnimationGroup): string {
  const a = g.targetedAnimations[0]?.animation
  if (!a) return g.name
  let id = animIds.get(a)
  if (id === undefined) animIds.set(a, (id = ++animSerial))
  return `${g.name}#${id}`
}

function fps(g: AnimationGroup): number {
  return g.targetedAnimations[0]?.animation.framePerSecond || 60
}

/** The world matrix of `n` now, its parents' too (the scene does not compute a hidden part's). */
function worldNow(n: TransformNode): Matrix {
  const chain: TransformNode[] = []
  for (let p: TransformNode | null = n; p; p = p.parent as TransformNode | null) chain.unshift(p)
  for (const p of chain) p.computeWorldMatrix(true)
  return n.getWorldMatrix()
}

const round4 = (v: number) => Math.round(v * 1e4)

// ---- the VAT -----------------------------------------------------------------------------------------------------------

export class VatKind {
  readonly slots: number
  readonly width: number
  readonly rows = new Map<string, VatRows>()
  used = 0
  capacity = 0
  data = new Float32Array(0)
  half = new Uint16Array(0)
  texture: RawTexture | null = null
  readonly manager: BakedVertexAnimationManager
  /** When the last upload was. */
  private uploadedAt = -Infinity
  private retired: RawTexture[] = []
  batches = 0
  idleSince = 0
  /** Clips that could not be baked (the texture is full): shown as the clip held before. */
  readonly refused = new Set<string>()
  bakeMs = 0
  baked = 0

  constructor(readonly scene: Scene, readonly key: string, bones: number, readonly lm: Matrix, private readonly maxRows: number) {
    this.slots = bones + 1
    this.width = this.slots * 4
    this.manager = new BakedVertexAnimationManager(scene)
    this.grow(FIRST_ROWS)
  }

  get bytes(): number {
    return this.capacity * this.width * 8
  }

  private grow(rows: number): boolean {
    let cap = Math.max(FIRST_ROWS, this.capacity)
    while (cap < rows) cap *= 2
    if (cap > this.maxRows) return false
    if (cap === this.capacity) return true
    const data = new Float32Array(cap * this.width * 4)
    data.set(this.data)
    const half = new Uint16Array(cap * this.width * 4)
    half.set(this.half)
    this.data = data
    this.half = half
    this.capacity = cap
    // a new texture of the new size (the old one goes once no frame can draw with it)
    if (this.texture) this.retired.push(this.texture)
    this.texture = RawTexture.CreateRGBATexture(half, this.width, cap, this.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT)
    this.texture.name = `crowdVat:${this.slots}x${cap}`
    this.manager.texture = this.texture
    return true
  }

  /** Rows baked but not on the GPU yet (an instance waits for the upload before it shows them). */
  private readonly fresh = new Set<VatRows>()

  /** The rows of clip `key` on the GPU (null: not baked or not uploaded yet, or refused). */
  get(key: string): VatRows | null {
    const r = this.rows.get(key)
    return r && !this.fresh.has(r) ? r : null
  }

  /** Baked (maybe not uploaded yet). */
  has(key: string): boolean {
    return this.rows.has(key)
  }

  /**
   * Bakes clip `g` from `subject`'s joints (its skeleton, `ref` the skinned part): every row's skin matrices × the parts'
   * transform to the root. The joints' pose is restored after; null when the texture is full.
   */
  bake(subject: CrowdSubject, ref: Mesh, g: AnimationGroup, key: string): VatRows | null {
    const had = this.rows.get(key)
    if (had) return had
    if (this.refused.has(key)) return null
    const skeleton = subject.skeleton
    if (!skeleton) return null
    const t0 = performance.now()
    const f = fps(g)
    const durationS = Math.max(0, (g.to - g.from) / f)
    const frames = rowsFor(durationS)
    if (!this.grow(this.used + frames)) {
      this.refused.add(key)
      return null
    }
    const rows: VatRows = { start: this.used, frames, durationS, loop: g.loopAnimation }
    // the joints' pose now (restored after the bake)
    const targets = new Set<TransformNode>()
    for (const ta of g.targetedAnimations) targets.add(ta.target as TransformNode)
    const snap = [...targets].map(n => [n, n.position?.clone(), n.rotationQuaternion?.clone(), n.scaling?.clone()] as const)
    const tmp = new Matrix()
    const out = new Matrix()
    const w = this.width * 4
    try {
      for (let j = 0; j < frames; j++) {
        const frame = Math.min(g.to, g.from + rowTime(j, frames, durationS) * f)
        for (const ta of g.targetedAnimations) {
          const an = ta.animation
          const v = an.evaluate(frame) as unknown
          const t = ta.target as Record<string, unknown>
          const prop = an.targetProperty
          const cur = t[prop] as { copyFrom?: (x: unknown) => void } | undefined
          if (v && typeof (v as { clone?: unknown }).clone === 'function' && cur && typeof cur.copyFrom === 'function') cur.copyFrom(v)
          else t[prop] = v && typeof (v as { clone?: () => unknown }).clone === 'function' ? (v as { clone: () => unknown }).clone() : v
        }
        skeleton.prepare(true)
        const mats = skeleton.getTransformMatrices(ref)
        const base = (rows.start + j) * w
        const n = Math.min(this.slots, Math.floor(mats.length / 16))
        for (let b = 0; b < n; b++) {
          Matrix.FromArrayToRef(mats, b * 16, tmp)
          tmp.multiplyToRef(this.lm, out)
          this.data.set(out.m, base + b * 16)
        }
        for (let b = n; b < this.slots; b++) this.data.set(this.lm.m, base + b * 16)
      }
    } finally {
      for (const [n, p, q, s] of snap) {
        if (p) n.position.copyFrom(p)
        if (q && n.rotationQuaternion) n.rotationQuaternion.copyFrom(q)
        if (s) n.scaling.copyFrom(s)
      }
      subject.crowdPoseTouched()
    }
    halves(this.data, this.half, rows.start * w, (rows.start + frames) * w)
    this.used += frames
    this.rows.set(key, rows)
    this.fresh.add(rows)
    this.dirty = true
    this.bakeMs += performance.now() - t0
    this.baked++
    return rows
  }

  private dirty = false

  /** Uploads the rows baked since the last upload (at most every UPLOAD_EVERY_MS; `force`: now). */
  upload(now: number, force = false): void {
    if (!this.dirty || !this.texture) return
    if (!force && now - this.uploadedAt < UPLOAD_EVERY_MS) return
    this.texture.update(this.half)
    this.dirty = false
    this.fresh.clear()
    this.uploadedAt = now
    this.uploads++
    for (const t of this.retired.splice(0)) t.dispose()
  }

  uploads = 0

  /** The skin matrix of bone column `col` at `row` × `world` into `out` (a rigid part's world matrix). */
  matrixAt(row: number, col: number, out: Matrix): Matrix {
    return Matrix.FromArrayToRef(this.data, (row * this.width + col * 4) * 4, out)
  }

  dispose(): void {
    for (const t of this.retired.splice(0)) t.dispose()
    this.texture?.dispose()
    this.texture = null
    this.manager.dispose()
  }
}

// ---- the batch -------------------------------------------------------------------------------------------------------

/** Thin-instance data of one batch mesh. */
interface BatchMesh {
  mesh: Mesh
}

export class CrowdBatch {
  readonly members: CrowdMember[] = []
  readonly meshes: BatchMesh[] = []
  mats = new Float32Array(16 * 4)
  vat = new Float32Array(4 * 4)
  items = new Float32Array(4 * 4)
  cap = 4
  /** Instances drawn at the last frame. */
  count = 0
  idleSince = 0

  constructor(readonly key: string, readonly kind: VatKind, readonly page: CrowdPage | null, readonly slot: number) {}

  /** (Re)binds the instance buffers of every mesh (after a growth). */
  bind(): void {
    for (const b of this.meshes) {
      b.mesh.thinInstanceSetBuffer('matrix', this.mats, 16, false)
      b.mesh.thinInstanceSetBuffer('bakedVertexAnimationSettingsInstanced', this.vat, 4, false)
      b.mesh.thinInstanceSetBuffer(CROWD_ITEM_KIND, this.items, 4, false)
      b.mesh.thinInstanceCount = 0
    }
  }

  ensure(n: number): void {
    if (n <= this.cap) return
    let cap = this.cap
    while (cap < n) cap *= 2
    const mats = new Float32Array(16 * cap)
    mats.set(this.mats)
    const vat = new Float32Array(4 * cap)
    vat.set(this.vat)
    const items = new Float32Array(4 * cap)
    items.set(this.items)
    this.mats = mats
    this.vat = vat
    this.items = items
    this.cap = cap
    this.bind()
  }
}

// ---- the atlas pages -------------------------------------------------------------------------------------------------

/** One atlas page of one VAT: PAGE_SLOTS outfit slots and the material every batch on it draws with. */
export class CrowdPage {
  readonly slots: (CrowdBatch | null)[] = new Array(PAGE_SLOTS).fill(null)
  used = 0
  idleSince = 0
  drawnFrames = 0

  constructor(readonly kind: VatKind, readonly texture: RenderTargetTexture, readonly material: PBRMaterial) {}

  /** The slot's top-left corner (page texels). */
  static origin(slot: number): { x: number; y: number } {
    const per = PAGE_SIZE / SLOT_SIZE
    return { x: (slot % per) * SLOT_SIZE, y: Math.floor(slot / per) * SLOT_SIZE }
  }

  dispose(): void {
    this.material.dispose(false, false)
    this.texture.dispose()
  }
}

// ---- the far weapon look -----------------------------------------------------------------------------------------------

/** The per-instance item codes' vertex kind (x weapon, y shield). */
export const CROWD_ITEM_KIND = 'sroCrowdItem'
export const CROWD_ITEM_PLUGIN = 'SroCrowdItem'

const GLOW_ROWS = 7
/** sroCrowdG1..7 (glow colour linear, steady glow), sroCrowdH0..1 (the rows' rim), sroCrowdR/T/A1..3 (seal rim, tint, accent), sroCrowdK (x exposure scale). */
const CROWD_UNIFORMS = [
  ...Array.from({ length: GLOW_ROWS }, (_, i) => `sroCrowdG${i + 1}`),
  'sroCrowdH0',
  'sroCrowdH1',
  ...[1, 2, 3].flatMap(t => [`sroCrowdR${t}`, `sroCrowdT${t}`, `sroCrowdA${t}`]),
  'sroCrowdK',
]

const lin = (c: readonly number[]) => [Math.pow(c[0]!, 2.2), Math.pow(c[1]!, 2.2), Math.pow(c[2]!, 2.2)]

/** The plugin's uniform values (the far look's tables; `sroCrowdK.x` is set per frame). */
export function crowdItemValues(): Record<string, number[]> {
  const v: Record<string, number[]> = {}
  WEAPON_GLOW_TIERS.slice(0, GLOW_ROWS).forEach((t, i) => {
    // the shimmer band crosses the blade about a third of the time at distance: a share of it in the steady glow
    v[`sroCrowdG${i + 1}`] = [...lin(t.color), t.glow + 0.15 * t.shimmer]
  })
  const rim = WEAPON_GLOW_TIERS.slice(0, GLOW_ROWS).map(t => t.rim)
  v.sroCrowdH0 = [rim[0] ?? 0, rim[1] ?? 0, rim[2] ?? 0, rim[3] ?? 0]
  v.sroCrowdH1 = [rim[4] ?? 0, rim[5] ?? 0, rim[6] ?? 0, SHIELD_STRENGTH]
  RARE_TIERS.forEach((tier: RarityTier, i) => {
    const l = RARITY_LOOKS[tier]
    v[`sroCrowdR${i + 1}`] = [...lin(l.rim), l.rimGain]
    v[`sroCrowdT${i + 1}`] = [...lin(l.tint), l.tintAmount]
    v[`sroCrowdA${i + 1}`] = [...lin(l.accent), 0.2 * l.pattern]
  })
  v.sroCrowdK = [1, 0, 0, 0]
  return v
}

const VERTEX_GLSL = {
  CUSTOM_VERTEX_DEFINITIONS: `
#ifdef SROCROWD
attribute vec4 sroCrowdItem;
#endif
`,
  CUSTOM_VERTEX_MAIN_END: `
#if defined(SROCROWD) && defined(MAINUV1)
{
  float scK = floor(uv.x * 0.5);
  float scC = scK > 1.5 ? (sroCrowdItem.y > 0.5 ? sroCrowdItem.y + 32.0 : 0.0) : (scK > 0.5 ? sroCrowdItem.x : 0.0);
  vMainUV1.x += 2.0 * (scC - scK);
}
#endif
`,
}

const VERTEX_WGSL = {
  CUSTOM_VERTEX_DEFINITIONS: `
#ifdef SROCROWD
attribute sroCrowdItem: vec4f;
#endif
`,
  CUSTOM_VERTEX_MAIN_END: `
#if defined(SROCROWD) && defined(MAINUV1)
{
  let scK = floor(vertexInputs.uv.x * 0.5);
  var scC = 0.0;
  if (scK > 1.5) {
    if (vertexInputs.sroCrowdItem.y > 0.5) { scC = vertexInputs.sroCrowdItem.y + 32.0; }
  } else if (scK > 0.5) {
    scC = vertexInputs.sroCrowdItem.x;
  }
  vertexOutputs.vMainUV1.x = vertexOutputs.vMainUV1.x + 2.0 * (scC - scK);
}
#endif
`,
}

/*
 * The fragment: the item code back from u (floor(u / 2): + level 0..7, + 8 × seal tier, + 32 on a shield), then the
 * seal's tint on the albedo (weapons; a shield's plate keeps its look, as near) and the glow and the seal's rim and
 * accent on the emissive, × the exposure scale (the tiers are display-relative, as weapon-glow.ts). The rows are
 * picked with if-chains (no uniform arrays in a plugin's block).
 */
const ALBEDO_GLSL = `
#if defined(SROCROWD) && defined(MAINUV1)
{
  float scCode = floor(vMainUV1.x * 0.5);
  if (scCode > 7.5 && scCode < 31.5) {
    float scR = floor(scCode / 8.0 + 0.001);
    vec4 scT = sroCrowdT1;
    if (scR > 1.5) { scT = sroCrowdT2; }
    if (scR > 2.5) { scT = sroCrowdT3; }
    float scL = dot(surfaceAlbedo, vec3(0.2126, 0.7152, 0.0722));
    surfaceAlbedo = mix(surfaceAlbedo, scT.rgb * clamp(scL * 2.4, 0.08, 1.5), scT.a);
  }
}
#endif
`

const ALBEDO_WGSL = `
#if defined(SROCROWD) && defined(MAINUV1)
{
  let scCode = floor(fragmentInputs.vMainUV1.x * 0.5);
  if (scCode > 7.5 && scCode < 31.5) {
    let scR = floor(scCode / 8.0 + 0.001);
    var scT = uniforms.sroCrowdT1;
    if (scR > 1.5) { scT = uniforms.sroCrowdT2; }
    if (scR > 2.5) { scT = uniforms.sroCrowdT3; }
    let scL = dot(surfaceAlbedo, vec3f(0.2126, 0.7152, 0.0722));
    surfaceAlbedo = mix(surfaceAlbedo, scT.rgb * clamp(scL * 2.4, 0.08, 1.5), scT.a);
  }
}
#endif
`

const EMISSIVE_GLSL = `
#if defined(SROCROWD) && defined(MAINUV1)
{
  float scCode = floor(vMainUV1.x * 0.5);
  if (scCode > 0.5) {
    float scShield = scCode > 31.5 ? 1.0 : 0.0;
    scCode -= 32.0 * scShield;
    float scR = floor(scCode / 8.0 + 0.001);
    float scP = scCode - 8.0 * scR;
    float scRim = 1.0 - abs(dot(normalW, viewDirectionW));
    float scRim3 = scRim * scRim * scRim;
    vec3 scE = vec3(0.0);
    if (scP > 0.5) {
      vec4 scG = sroCrowdG1;
      float scK = sroCrowdH0.x;
      if (scP > 1.5) { scG = sroCrowdG2; scK = sroCrowdH0.y; }
      if (scP > 2.5) { scG = sroCrowdG3; scK = sroCrowdH0.z; }
      if (scP > 3.5) { scG = sroCrowdG4; scK = sroCrowdH0.w; }
      if (scP > 4.5) { scG = sroCrowdG5; scK = sroCrowdH1.x; }
      if (scP > 5.5) { scG = sroCrowdG6; scK = sroCrowdH1.y; }
      if (scP > 6.5) { scG = sroCrowdG7; scK = sroCrowdH1.z; }
      scE += scG.rgb * (scG.a + scK * scRim3);
    }
    if (scR > 0.5) {
      vec4 scRr = sroCrowdR1;
      vec4 scA = sroCrowdA1;
      if (scR > 1.5) { scRr = sroCrowdR2; scA = sroCrowdA2; }
      if (scR > 2.5) { scRr = sroCrowdR3; scA = sroCrowdA3; }
      scE += scRr.rgb * (scRr.a * (0.25 + scRim * scRim)) + scA.rgb * scA.a;
    }
    scE *= mix(1.0, sroCrowdH1.w, scShield);
    finalEmissive += scE * sroCrowdK.x;
  }
}
#endif
`

const EMISSIVE_WGSL = `
#if defined(SROCROWD) && defined(MAINUV1)
{
  var scCode = floor(fragmentInputs.vMainUV1.x * 0.5);
  if (scCode > 0.5) {
    let scShield = select(0.0, 1.0, scCode > 31.5);
    scCode = scCode - 32.0 * scShield;
    let scR = floor(scCode / 8.0 + 0.001);
    let scP = scCode - 8.0 * scR;
    let scRim = 1.0 - abs(dot(normalW, viewDirectionW));
    let scRim3 = scRim * scRim * scRim;
    var scE = vec3f(0.0);
    if (scP > 0.5) {
      var scG = uniforms.sroCrowdG1;
      var scK = uniforms.sroCrowdH0.x;
      if (scP > 1.5) { scG = uniforms.sroCrowdG2; scK = uniforms.sroCrowdH0.y; }
      if (scP > 2.5) { scG = uniforms.sroCrowdG3; scK = uniforms.sroCrowdH0.z; }
      if (scP > 3.5) { scG = uniforms.sroCrowdG4; scK = uniforms.sroCrowdH0.w; }
      if (scP > 4.5) { scG = uniforms.sroCrowdG5; scK = uniforms.sroCrowdH1.x; }
      if (scP > 5.5) { scG = uniforms.sroCrowdG6; scK = uniforms.sroCrowdH1.y; }
      if (scP > 6.5) { scG = uniforms.sroCrowdG7; scK = uniforms.sroCrowdH1.z; }
      scE = scE + scG.rgb * (scG.a + scK * scRim3);
    }
    if (scR > 0.5) {
      var scRr = uniforms.sroCrowdR1;
      var scA = uniforms.sroCrowdA1;
      if (scR > 1.5) { scRr = uniforms.sroCrowdR2; scA = uniforms.sroCrowdA2; }
      if (scR > 2.5) { scRr = uniforms.sroCrowdR3; scA = uniforms.sroCrowdA3; }
      scE = scE + scRr.rgb * (scRr.a * (0.25 + scRim * scRim)) + scA.rgb * scA.a;
    }
    scE = scE * mix(1.0, uniforms.sroCrowdH1.w, scShield);
    finalEmissive = finalEmissive + scE * uniforms.sroCrowdK.x;
  }
}
#endif
`

function fragmentCode(lang: 'glsl' | 'wgsl'): Record<string, string> {
  const wgsl = lang === 'wgsl'
  return { CUSTOM_FRAGMENT_UPDATE_ALPHA: wgsl ? ALBEDO_WGSL : ALBEDO_GLSL, CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: wgsl ? EMISSIVE_WGSL : EMISSIVE_GLSL }
}

/** The far weapon look on a crowd atlas material: only crowd batch meshes (metadata.sroCrowd) turn it on. */
export class CrowdItemPlugin extends MaterialPluginBase {
  constructor(material: Material, private readonly values: Record<string, number[]>) {
    // priority 320: after the glow (300) and the seal (310), all of which add to the emissive at the same point
    super(material, CROWD_ITEM_PLUGIN, 320, { SROCROWD: false }, true, false)
    this.registerForExtraEvents = true
    this._enable(true)
  }

  override getClassName(): string {
    return CROWD_ITEM_PLUGIN
  }

  override isCompatible(): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene?: Scene, mesh?: AbstractMesh): void {
    const d = defines as MaterialDefines & Record<string, unknown>
    const on = !!mesh && (mesh.metadata as { sroCrowd?: boolean } | null)?.sroCrowd === true && d.INSTANCES === true
    if (d.SROCROWD !== on) {
      d.SROCROWD = on
      defines.markAsUnprocessed()
    }
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if ((mesh.metadata as { sroCrowd?: boolean } | null)?.sroCrowd === true) attributes.push(CROWD_ITEM_KIND)
  }

  override getUniforms(shaderLanguage?: ShaderLanguage): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: CROWD_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      fragment: shaderLanguage === ShaderLanguage.WGSL ? '' : CROWD_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n'),
    }
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    for (const n of CROWD_UNIFORMS) {
      const v = this.values[n]!
      ubo.updateFloat4(n, v[0]!, v[1]!, v[2]!, v[3]!)
    }
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    const wgsl = shaderLanguage === ShaderLanguage.WGSL
    if (shaderType === 'vertex') return { ...(wgsl ? VERTEX_WGSL : VERTEX_GLSL) }
    if (shaderType === 'fragment') return fragmentCode(wgsl ? 'wgsl' : 'glsl')
    return null
  }
}

/** The shader text of the plugin (tests check both languages carry the same hooks). */
export function crowdItemCode(lang: 'glsl' | 'wgsl'): { vertex: Record<string, string>; fragment: Record<string, string> } {
  return { vertex: lang === 'wgsl' ? VERTEX_WGSL : VERTEX_GLSL, fragment: fragmentCode(lang) }
}

// ---- the tier --------------------------------------------------------------------------------------------------------

export interface CrowdTierStats {
  kinds: number
  rows: number
  vatMB: number
  batches: number
  members: number
  drawn: number
  meshes: number
  bakes: number
  bakeMs: number
  refused: number
  joins: number
  rejected: Record<string, number>
  /** Atlas pages alive (one material each). */
  pages: number
}

/** The crowd tier of one scene (ModelLibrary owns one). */
export class CrowdTier {
  private readonly kinds = new Map<string, VatKind>()
  private readonly batches = new Map<string, CrowdBatch>()
  private readonly pages = new Map<VatKind, CrowdPage[]>()
  /** A fully transparent texel: what a reused slot is cleared with. */
  private clearTex: RawTexture | null = null
  private readonly members = new Set<CrowdMember>()
  private readonly pending = new Map<number, { member: CrowdMember; group: AnimationGroup; kind: VatKind }>()
  private dummy: Skeleton | null = null
  private epoch: number
  private serial = 0
  readonly values = crowdItemValues()
  joins = 0
  readonly rejected: Record<string, number> = {}
  private readonly maxRows: number

  constructor(
    readonly scene: Scene,
    private readonly atlases: () => OutfitAtlases | null,
    private readonly now: () => number = () => performance.now(),
    /** The library's material decorators (the PBR path's character surface, the lights), run on each page material. */
    private readonly decorate: (mat: Material) => void = () => {},
  ) {
    this.epoch = this.now()
    const caps = scene.getEngine().getCaps()
    this.maxRows = Math.min(MAX_ROWS, caps.maxTextureSize || MAX_ROWS)
  }

  /** The VAT clock now (s). */
  clock(): number {
    return CLOCK_BASE_S + (this.now() - this.epoch) / 1000
  }

  private reject(why: string): null {
    this.rejected[why] = (this.rejected[why] ?? 0) + 1
    return null
  }

  /**
   * Takes `subject` into the tier with its drawn `parts` (the caller hides them on success). null when it cannot: no
   * skeleton or no clip, parts not on one transform, a clip the VAT has no room for, a part the batch cannot draw.
   */
  join(subject: CrowdSubject, parts: readonly CrowdPart[]): CrowdMember | null {
    const skeleton = subject.skeleton
    if (!skeleton || subject.isDisposed) return this.reject('skeleton')
    const top = subject.crowdTop()
    if (!top || !top.targetedAnimations.length || !(top.to > top.from)) return this.reject('clip')
    const skinned = parts.filter(p => !p.socket)
    const ref = skinned[0]?.mesh
    if (!ref) return this.reject('no skinned part')
    const root = subject.root
    const rootInv = Matrix.Invert(worldNow(root))
    const lm = worldNow(ref).multiply(rootInv)
    for (const p of skinned) {
      if (p.mesh.skeleton !== skeleton) return this.reject('skeleton of its own')
      const l = worldNow(p.mesh).multiply(rootInv)
      for (let i = 0; i < 16; i++) if (Math.abs(l.m[i]! - lm.m[i]!) > 1e-4) return this.reject('part transform')
    }
    // the VAT of this skeleton signature (inverse binds, the parts' transform, the skin)
    const sig: (string | number)[] = [subject.crowdSkinKey, skeleton.bones.length]
    for (const b of skeleton.bones) {
      sig.push(b.name)
      const ib = b.getAbsoluteInverseBindMatrix().m
      for (let i = 0; i < 16; i++) sig.push(round4(ib[i]!))
    }
    for (let i = 0; i < 16; i++) sig.push(round4(lm.m[i]!))
    const kindKey = sig.join(',')
    let kind = this.kinds.get(kindKey)
    if (!kind) {
      kind = new VatKind(this.scene, kindKey, skeleton.bones.length, lm.clone(), this.maxRows)
      this.kinds.set(kindKey, kind)
    }
    // the rigid parts: their transform into the socket bone's VAT matrix, from the pose now (C = R × VAT⁻¹)
    skeleton.prepare(true)
    const mats = skeleton.getTransformMatrices(ref)
    const rigid: CrowdMember['rigid'] = []
    const rigidC = new Map<Mesh, { col: number; c: Matrix }>()
    for (const p of parts) {
      if (!p.socket) continue
      if (p.mesh.skeleton) return this.reject('skinned socket item')
      const col = boneColumn(skeleton, p.socket.bone)
      if (col < 0 || col * 16 + 16 > mats.length) return this.reject('socket bone')
      const vat = Matrix.FromArray(mats, col * 16).multiply(lm)
      const r = worldNow(p.mesh).multiply(rootInv)
      const c = r.multiply(Matrix.Invert(vat))
      rigidC.set(p.mesh, { col, c })
      rigid.push({ mesh: p.mesh, col, c, world: new Matrix() })
    }
    subject.crowdPoseTouched()
    // the current clip, baked now (a member is never drawn without its rows)
    const clipKey = clipKeyOf(top)
    const rows = kind.bake(subject, ref, top, clipKey)
    if (!rows) return this.reject('vat full')
    kind.upload(this.now(), true)
    const batch = this.batchFor(kind, parts, rigidC, ref)
    if (!batch) return this.reject('batch')
    const member: CrowdMember = {
      subject,
      batch,
      parts: parts.map(p => p.mesh),
      ref,
      clock: null,
      clipKey,
      group: null,
      master: NaN,
      speed: 1,
      rigid,
      frozen: false,
      left: false,
    }
    this.syncClock(member, top, this.clock())
    for (const p of member.parts) crowdDrawn.add(p)
    batch.members.push(member)
    this.members.add(member)
    this.joins++
    return member
  }

  /** Takes a member out (its parts are the caller's again; the rigid parts' world matrices compute again). */
  leave(member: CrowdMember): void {
    if (member.left) return
    member.left = true
    this.members.delete(member)
    this.pending.delete(this.pendingKey(member))
    const list = member.batch.members
    const i = list.indexOf(member)
    if (i >= 0) {
      list[i] = list[list.length - 1]!
      list.pop()
    }
    if (!list.length) member.batch.idleSince = this.now()
    for (const p of member.parts) crowdDrawn.delete(p)
    if (member.frozen) {
      for (const r of member.rigid) if (!r.mesh.isDisposed()) r.mesh.unfreezeWorldMatrix()
      member.frozen = false
    }
  }

  private pendingKey(m: CrowdMember): number {
    return m.subject.root.uniqueId
  }

  /** The outfit batch for these parts (built when new). */
  private batchFor(kind: VatKind, parts: readonly CrowdPart[], rigid: Map<Mesh, { col: number; c: Matrix }>, ref: Mesh): CrowdBatch | null {
    // an atlas when the parts draw from more than one material; one shared material keeps it (monsters, NPCs)
    const atlasable: { part: CrowdPart; op: OutfitPart }[] = []
    const apart: CrowdPart[] = []
    for (const p of parts) {
      const op = outfitPartOf(p.mesh, p.socket ? null : ref.skeleton!)
      if (op && uvFits(p.mesh.getVerticesData(VertexBuffer.UVKind) ?? [2])) atlasable.push({ part: p, op })
      else apart.push(p)
    }
    const mats = new Set(atlasable.map(a => a.part.mesh.material))
    const useAtlas = mats.size > 1 || atlasable.some(a => !!a.part.socket)
    const keyParts: string[] = []
    for (const p of parts) {
      const r = rigid.get(p.mesh)
      const mat = p.mesh.material as PBRMaterial | null
      keyParts.push(`${p.mesh.geometry?.uniqueId ?? p.mesh.uniqueId}:${mat?.uniqueId ?? -1}:${mat?.albedoTexture?.uniqueId ?? -1}${r ? `@${r.col}:${p.socket!.item}:${Array.from(r.c.m, round4).join(',')}` : ''}`)
    }
    const key = `${kind.key.length}:${hashString(kind.key)}|${useAtlas ? 'a' : 'm'}|${keyParts.join(';')}`
    const had = this.batches.get(key)
    if (had) return had
    let slot: { page: CrowdPage; slot: number; rects: Map<number, { x: number; y: number; w: number; h: number }> } | null = null
    const meshes: Mesh[] = []
    const name = `crowd${++this.serial}`
    const freeSlot = () => {
      if (!slot) return
      slot.page.slots[slot.slot] = null
      if (--slot.page.used <= 0) slot.page.idleSince = this.now()
    }
    if (atlasable.length) {
      if (useAtlas) {
        slot = this.slotFor(kind, atlasable.map(a => a.op))
        if (!slot) return null
      }
      const m = buildCrowdMesh(atlasable.map(a => ({ mesh: a.part.mesh, item: a.part.socket?.item ?? 0, rigid: rigid.get(a.part.mesh) ?? null, rect: slot ? slot.rects.get(a.op.texture.uniqueId)! : null })), slot ? PAGE_SIZE : 0, `${name}:a`)
      if (!m) {
        freeSlot()
        return null
      }
      m.material = slot ? slot.page.material : atlasable[0]!.part.mesh.material
      meshes.push(m)
    }
    for (const p of apart) {
      const m = buildCrowdMesh([{ mesh: p.mesh, item: 0, rigid: rigid.get(p.mesh) ?? null, rect: null }], 0, `${name}:${meshes.length}`)
      if (!m) {
        for (const x of meshes) x.dispose(false, false)
        freeSlot()
        return null
      }
      m.material = p.mesh.material
      meshes.push(m)
    }
    const batch = new CrowdBatch(key, kind, slot?.page ?? null, slot?.slot ?? -1)
    if (slot) slot.page.slots[slot.slot] = batch
    const dummy = this.dummySkeleton()
    for (const m of meshes) {
      m.skeleton = dummy
      m.numBoneInfluencers = 4
      m.bakedVertexAnimationManager = kind.manager
      m.receiveShadows = ref.receiveShadows
      m.layerMask = ref.layerMask
      m.renderingGroupId = ref.renderingGroupId
      m.isPickable = false
      m.alwaysSelectAsActiveMesh = true
      m.doNotSyncBoundingInfo = true
      m.metadata = { sroCrowd: true }
      m.freezeWorldMatrix()
      m.isVisible = false
      batch.meshes.push({ mesh: m })
    }
    batch.bind()
    kind.batches++
    this.batches.set(key, batch)
    return batch
  }

  /**
   * A free slot on a page of `kind` (a new page when all are full) with the parts' textures copied in: their rects in
   * page texels by texture id. null while the copy pass compiles or the textures do not fit a slot.
   */
  private slotFor(kind: VatKind, parts: readonly OutfitPart[]): { page: CrowdPage; slot: number; rects: Map<number, { x: number; y: number; w: number; h: number }> } | null {
    const src = this.atlases()
    if (!src || !src.ready()) return null
    const textures: BaseTexture[] = []
    const ids = new Map<number, number>()
    for (const p of parts) {
      if (ids.has(p.texture.uniqueId)) continue
      ids.set(p.texture.uniqueId, textures.length)
      textures.push(p.texture)
    }
    const cut = textures.map(t => parts.some(p => p.texture === t && p.cutout))
    const plan = packAtlas(textures.map(atlasSizeOf), SLOT_SIZE)
    if (!plan) return null
    let pages = this.pages.get(kind)
    if (!pages) this.pages.set(kind, (pages = []))
    let page = pages.find(p => p.used < PAGE_SLOTS) ?? null
    if (!page) {
      page = this.newPage(kind, pages.length)
      pages.push(page)
    }
    const slot = page.slots.indexOf(null)
    const o = CrowdPage.origin(slot)
    // the slot as it was left by an outfit before: cleared to transparent black first
    const clear = (this.clearTex ??= RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, this.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE))
    src.copyInto(page.texture, PAGE_SIZE, [clear], [{ x: o.x + ATLAS_PAD, y: o.y + ATLAS_PAD, w: SLOT_SIZE - 2 * ATLAS_PAD, h: SLOT_SIZE - 2 * ATLAS_PAD }], [true])
    const rects = plan.rects.map(r => ({ x: r.x + o.x, y: r.y + o.y, w: r.w, h: r.h }))
    src.copyInto(page.texture, PAGE_SIZE, textures, rects, cut)
    // copied again a few frames later and once more after a second (§16.8: on a busy load the first copy of a slot
    // could land before its source maps were on the GPU, leaving the slot transparent: whole outfits not drawn)
    for (const after of RECOPY_FRAMES) this.recopies.push({ at: this.frameNo + after, page, slot, textures, rects, cut })
    page.used++
    const out = new Map<number, { x: number; y: number; w: number; h: number }>()
    for (const [id, i] of ids) out.set(id, rects[i]!)
    return { page, slot, rects: out }
  }

  private newPage(kind: VatKind, n: number): CrowdPage {
    const rtt = new RenderTargetTexture(`crowdPage${n}`, { width: PAGE_SIZE, height: PAGE_SIZE }, this.scene, {
      generateMipMaps: true,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      format: Constants.TEXTUREFORMAT_RGBA,
      samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
      generateDepthBuffer: false,
      noColorAttachment: false,
    })
    rtt.gammaSpace = true
    // u repeats: an item's u moved by 2 × its code samples the same texel (the far weapon look)
    rtt.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE
    rtt.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE
    rtt.anisotropicFilteringLevel = 1
    rtt.hasAlpha = true
    const engine = this.scene.getEngine()
    engine.bindFramebuffer(rtt.renderTarget!)
    engine.clear(new Color4(0, 0, 0, 0), true, false, false)
    engine.unBindFramebuffer(rtt.renderTarget!)
    const mat = new PBRMaterial(`crowdPage${n}`, this.scene)
    mat.albedoTexture = rtt
    mat.metallic = 0
    mat.roughness = 1
    // one material for every outfit on the page: cut out (an opaque part's texels have alpha 1) and two-sided
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    mat.alphaCutOff = 0.5
    mat.backFaceCulling = false
    mat.twoSidedLighting = true
    this.decorate(mat)
    new CrowdItemPlugin(mat, this.values)
    return new CrowdPage(kind, rtt, mat)
  }

  /** One skeleton for every batch mesh (Babylon wants one for the bone influences; the VAT replaces its matrices). */
  private dummySkeleton(): Skeleton {
    if (!this.dummy) {
      this.dummy = new Skeleton('crowdTier', 'crowdTier', this.scene)
      new Bone('b0', this.dummy)
    }
    return this.dummy
  }

  /** Reads the subject's clip into the member's clock (a new clip, a seek, a speed change). */
  private syncClock(m: CrowdMember, top: AnimationGroup | null, t: number): void {
    if (!top) return
    const key = top === m.group ? m.clipKey : clipKeyOf(top)
    const kind = m.batch.kind
    const rows = kind.get(key)
    if (!rows) {
      // not baked yet: bake soon (not uploaded yet: soon too); the instance holds what it showed
      if (!kind.has(key) && !kind.refused.has(key)) this.pending.set(this.pendingKey(m), { member: m, group: top, kind })
      return
    }
    // a clip that ended holds its last frame (a looping one that stopped, its first)
    const a = top.animatables[0]
    const master = a ? a.masterFrame : top.isPlaying || top.loopAnimation ? top.from : top.to
    const speed = top.isPlaying ? top.speedRatio || 0 : 0
    const clipS = Math.max(0, (master - top.from) / fps(top))
    if (top === m.group && m.clock && m.clock.rows === rows) {
      if (master === m.master && speed === m.speed) return
      // a step of the same clip: keep the clock unless the clip was seeked (or its speed changed)
      const want = clipTimeAt(m.clock, t)
      let diff = Math.abs(want - clipS)
      if (rows.loop && rows.durationS > 0) diff = Math.min(diff, rows.durationS - diff)
      m.master = master
      if (diff <= RESYNC_S && speed === m.speed) return
    }
    m.group = top
    m.clipKey = key
    m.master = master
    m.speed = speed
    m.clock = { rows, clipS, atS: t, speed }
  }

  /** Per frame (after the animations and the cull, before the active meshes): clocks, bakes, instances, uploads. */
  /** Slot copies to make again (slotFor): when, where, what. */
  private readonly recopies: { at: number; page: CrowdPage; slot: number; textures: BaseTexture[]; rects: { x: number; y: number; w: number; h: number }[]; cut: boolean[] }[] = []
  private frameNo = 0

  private recopy(): void {
    const src = this.atlases()
    if (!src || !src.ready()) return
    for (let i = this.recopies.length - 1; i >= 0; i--) {
      const r = this.recopies[i]!
      if (r.at > this.frameNo) continue
      this.recopies.splice(i, 1)
      // the slot must still hold the batch it was copied for (a freed slot is someone else's now)
      if (!r.page.slots[r.slot] || !r.page.texture.getInternalTexture() || r.textures.some(t => !t.isReady())) continue
      src.copyInto(r.page.texture, PAGE_SIZE, r.textures, r.rects, r.cut)
      this.recopied++
    }
  }

  /** Slot copies made again (stats). */
  recopied = 0

  frame(): void {
    this.frameNo++
    if (this.recopies.length) this.recopy()
    if (!this.members.size && !this.batches.size) return
    const now = this.now()
    let t = this.clock()
    if (t > CLOCK_REBASE_S) {
      // the clock goes back to its base; every clock keeps its clip time (only T − atS matters)
      const d = t - CLOCK_BASE_S
      this.epoch += d * 1000
      t -= d
      for (const m of this.members) if (m.clock) m.clock.atS -= d
    }
    for (const k of this.kinds.values()) k.manager.time = t
    for (const m of this.members) {
      if (m.subject.isDisposed) continue
      this.syncClock(m, m.subject.crowdTop(), t)
    }
    this.bakePending(now, t)
    for (const k of this.kinds.values()) k.upload(now)
    const s = new Float32Array(4)
    for (const b of this.batches.values()) {
      let n = 0
      let dm = false
      let dv = false
      let di = false
      if (b.members.length) b.ensure(b.members.length)
      for (const m of b.members) {
        const sub = m.subject
        if (sub.isDisposed || sub.isOffscreen || !sub.root.isEnabled() || !m.clock) continue
        const wmat = sub.root.computeWorldMatrix()
        const wm = wmat.m
        const o16 = n * 16
        for (let i = 0; i < 16; i++) {
          if (b.mats[o16 + i] !== wm[i]) {
            b.mats[o16 + i] = wm[i]!
            dm = true
          }
        }
        vatSettings(m.clock, t, s)
        const o4 = n * 4
        for (let i = 0; i < 4; i++) {
          if (b.vat[o4 + i] !== s[i]) {
            b.vat[o4 + i] = s[i]!
            dv = true
          }
        }
        const codes = sub.crowdItems()
        const w = codes & 0xff
        const sh = (codes >> 8) & 0xff
        if (b.items[o4] !== w || b.items[o4 + 1] !== sh) {
          b.items[o4] = w
          b.items[o4 + 1] = sh
          di = true
        }
        if (m.rigid.length && sub.crowdRare()) this.followRigid(m, t, wmat)
        n++
      }
      if (n !== b.count) {
        b.count = n
        dm = dv = di = true
      }
      for (const { mesh } of b.meshes) {
        if (mesh.thinInstanceCount !== n) mesh.thinInstanceCount = n
        if (n > 0) {
          if (dm) mesh.thinInstanceBufferUpdated('matrix')
          if (dv) mesh.thinInstanceBufferUpdated('bakedVertexAnimationSettingsInstanced')
          if (di) mesh.thinInstanceBufferUpdated(CROWD_ITEM_KIND)
        }
        mesh.isVisible = n > 0
      }
    }
    this.values.sroCrowdK![0] = exposureScale(sceneExposure(this.scene))
    this.freezeMaterials(now)
    this.evict(now)
  }

  private thawAt = 0
  /** Frozen crowd atlas materials (tests, the bench). */
  readonly frozenMats = new Set<Material>()

  private freezeMaterials(now: number): void {
    const thaw = now >= this.thawAt
    if (thaw) this.thawAt = now + THAW_EVERY_MS
    for (const pages of this.pages.values()) {
      for (const p of pages) {
        const mat = p.material
        if (!p.used) continue
        p.drawnFrames++
        if (thaw) {
          if (mat.isFrozen) mat.unfreeze()
          this.frozenMats.delete(mat)
        } else if (!mat.isFrozen && p.drawnFrames > FREEZE_AFTER_FRAMES) {
          mat.freeze()
          this.frozenMats.add(mat)
        }
      }
    }
  }

  /** A rare item's meshes follow the instance (their world matrix from the VAT row: the seal effects read it). */
  private followRigid(m: CrowdMember, t: number, root: Matrix): void {
    const kind = m.batch.kind
    const row = wantedRow(m.clock!, t)
    const vm = scratchA
    for (const r of m.rigid) {
      if (r.mesh.isDisposed()) continue
      kind.matrixAt(row, r.col, vm)
      r.c.multiplyToRef(vm, scratchC)
      scratchC.multiplyToRef(root, r.world)
      r.mesh.freezeWorldMatrix(r.world)
    }
    m.frozen = true
  }

  /** Bakes the clips the crowd waits for, within BAKE_BUDGET_MS (at least one a frame). */
  private bakePending(now: number, t: number): void {
    if (!this.pending.size) return
    const end = now + BAKE_BUDGET_MS
    let first = true
    for (const [k, p] of this.pending) {
      if (!first && performance.now() > end) break
      first = false
      this.pending.delete(k)
      const m = p.member
      if (m.left || m.subject.isDisposed) continue
      p.kind.bake(m.subject, m.ref, p.group, clipKeyOf(p.group))
      this.syncClock(m, m.subject.crowdTop(), t)
    }
  }

  private evict(now: number): void {
    for (const [k, b] of this.batches) {
      if (b.members.length || now - b.idleSince < BATCH_EVICT_MS) continue
      for (const { mesh } of b.meshes) mesh.dispose(false, false)
      if (b.page) {
        b.page.slots[b.slot] = null
        if (--b.page.used <= 0) b.page.idleSince = now
      }
      this.batches.delete(k)
      if (--b.kind.batches <= 0) b.kind.idleSince = now
    }
    for (const [kind, pages] of this.pages) {
      for (let i = pages.length - 1; i >= 0; i--) {
        const p = pages[i]!
        if (p.used > 0 || now - p.idleSince < BATCH_EVICT_MS) continue
        this.frozenMats.delete(p.material)
        p.dispose()
        pages.splice(i, 1)
      }
      if (!pages.length) this.pages.delete(kind)
    }
    for (const [k, kind] of this.kinds) {
      if (kind.batches > 0 || now - kind.idleSince < KIND_EVICT_MS) continue
      kind.dispose()
      this.kinds.delete(k)
    }
  }

  stats(): CrowdTierStats {
    let rows = 0
    let bytes = 0
    let bakes = 0
    let bakeMs = 0
    let refused = 0
    for (const k of this.kinds.values()) {
      rows += k.used
      bytes += k.bytes
      bakes += k.baked
      bakeMs += k.bakeMs
      refused += k.refused.size
    }
    let drawn = 0
    let meshes = 0
    for (const b of this.batches.values()) {
      drawn += b.count
      if (b.count) meshes += b.meshes.length
    }
    return {
      kinds: this.kinds.size,
      rows,
      vatMB: Math.round((bytes / 1048576) * 10) / 10,
      batches: this.batches.size,
      members: this.members.size,
      drawn,
      meshes,
      bakes,
      bakeMs: Math.round(bakeMs),
      refused,
      joins: this.joins,
      rejected: { ...this.rejected },
      pages: [...this.pages.values()].reduce((n, p) => n + p.length, 0),
    }
  }

  dispose(): void {
    for (const m of [...this.members]) this.leave(m)
    for (const b of this.batches.values()) for (const { mesh } of b.meshes) mesh.dispose(false, false)
    this.batches.clear()
    for (const pages of this.pages.values()) for (const p of pages) p.dispose()
    this.pages.clear()
    this.clearTex?.dispose()
    this.clearTex = null
    for (const k of this.kinds.values()) k.dispose()
    this.kinds.clear()
    this.dummy?.dispose()
    this.dummy = null
  }
}

const scratchA = new Matrix()
const scratchC = new Matrix()

/** FNV-1a of a string (a short batch key for a long VAT key). */
function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** One part of a crowd mesh: skinned as it is, or rigid (moved by `rigid.c`, bound to `rigid.col`); its atlas rect. */
export interface CrowdMeshPart {
  mesh: Mesh
  item: number
  rigid: { col: number; c: Matrix } | null
  rect: { x: number; y: number; w: number; h: number } | null
}

const tv = new Vector3()
const tn = new Vector3()

/**
 * The batch mesh of `parts` (positions, normals, UVs, 4 bone indices and weights): skinned parts as they are, a rigid
 * part's vertices moved into its socket bone's skin space and bound to that bone alone; UVs into each part's atlas rect
 * (`size` > 0) with a rigid item's kind added as 2 × kind to u (crowd-vat.ts ITEM_*). null when a part has no data.
 */
export function buildCrowdMesh(parts: readonly CrowdMeshPart[], size: number, name: string): Mesh | null {
  const first = parts[0]?.mesh
  if (!first) return null
  let verts = 0
  for (const p of parts) verts += p.mesh.getTotalVertices()
  if (!verts) return null
  const pos = new Float32Array(verts * 3)
  const nrm = new Float32Array(verts * 3)
  const uvs = new Float32Array(verts * 2)
  const mi = new Float32Array(verts * 4)
  const mw = new Float32Array(verts * 4)
  const idx: number[] = []
  let base = 0
  for (const p of parts) {
    const m = p.mesh
    const n = m.getTotalVertices()
    const P = m.getVerticesData(VertexBuffer.PositionKind)
    const N = m.getVerticesData(VertexBuffer.NormalKind)
    const U = m.getVerticesData(VertexBuffer.UVKind)
    const ind = m.getIndices()
    if (!P || !ind) return null
    if (p.rigid) {
      const c = p.rigid.c
      for (let i = 0; i < n; i++) {
        Vector3.TransformCoordinatesFromFloatsToRef(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!, c, tv)
        pos[(base + i) * 3] = tv.x
        pos[(base + i) * 3 + 1] = tv.y
        pos[(base + i) * 3 + 2] = tv.z
        if (N) {
          Vector3.TransformNormalFromFloatsToRef(N[i * 3]!, N[i * 3 + 1]!, N[i * 3 + 2]!, c, tn)
          tn.normalize()
          nrm[(base + i) * 3] = tn.x
          nrm[(base + i) * 3 + 1] = tn.y
          nrm[(base + i) * 3 + 2] = tn.z
        }
        mi[(base + i) * 4] = p.rigid.col
        mw[(base + i) * 4] = 1
      }
    } else {
      pos.set(P.slice(0, n * 3), base * 3)
      if (N) nrm.set(N.slice(0, n * 3), base * 3)
      const ji = m.getVerticesData(VertexBuffer.MatricesIndicesKind)
      const jw = m.getVerticesData(VertexBuffer.MatricesWeightsKind)
      if (!ji || !jw) return null
      mi.set(ji.slice(0, n * 4), base * 4)
      mw.set(jw.slice(0, n * 4), base * 4)
    }
    const out = uvs.subarray(base * 2, (base + n) * 2)
    if (U) {
      if (p.rect && size > 0) remapUV(U, p.rect, size, out)
      else out.set(U.slice(0, n * 2))
      if (p.item && size > 0) for (let i = 0; i < n; i++) out[i * 2] = out[i * 2]! + 2 * p.item
    }
    for (let i = 0; i < ind.length; i++) idx.push(ind[i]! + base)
    base += n
  }
  const vd = new VertexData()
  vd.positions = pos
  vd.normals = nrm
  vd.uvs = uvs
  vd.matricesIndices = mi
  vd.matricesWeights = mw
  vd.indices = verts > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx)
  const mesh = new Mesh(name, first.getScene())
  vd.applyToMesh(mesh, false)
  mesh.sideOrientation = first.sideOrientation
  mesh.overrideMaterialSideOrientation = first.overrideMaterialSideOrientation
  return mesh
}
