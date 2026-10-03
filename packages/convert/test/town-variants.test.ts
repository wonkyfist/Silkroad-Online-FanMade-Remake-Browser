/**
 * TL-V's converter units (docs/TOWN_LIFE.md §3.2; WAVE_PLAN7 §6.1 lane TL-V, §5.3): the atlas packer and rasteriser,
 * the half floats, the VAT layout (Babylon's baker's: (joints + 1) × 4 texels per row, the identity last), the tile
 * normalisation, and the dresser on synthetic glbs: one mesh + one material, joints remapped by NAME (a garment whose
 * skin lists the joints in another order skins exactly like the original), the retail emissive zeroed and reported as
 * `selfLit`, double-sided pieces mirrored, a part bound otherwise refused. The NullEngine parity of the VATs with the
 * real retail clips is world-render/test/town-vat.test.ts.
 */
import { Document, type Node } from '@gltf-transform/core'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { atlasUv, buildAtlas, GUTTER, packShelves, sourceRect, type AtlasSource, type RgbaImage } from '../src/town/atlas.ts'
import { crowdKindOf } from '../src/town/export-town.ts'
import { dressVariant, normaliseTiles, peopleClips, skeletonOf, TOWN_MODELS, TOWN_PEOPLE } from '../src/town/variants.ts'
import { bakeVat, clipFrames, encodeHalf, fromHalf, toHalf, vatFile, vatMatrix } from '../src/town/vat.ts'

// ---- synthetic skinned glbs --------------------------------------------------------------------------------------

const JOINTS = ['Bip01', 'Bip01 Spine', 'Bip01 Head']

async function png(w: number, h: number, rgba: (x: number, y: number) => [number, number, number, number]): Promise<Uint8Array> {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(rgba(x, y), (y * w + x) * 4)
  return new Uint8Array(await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer())
}

interface PieceOpts {
  name: string
  /** Skin joint order (names); JOINTS_0 refer to it. */
  order?: string[]
  emissive?: [number, number, number]
  doubleSided?: boolean
  alpha?: 'OPAQUE' | 'MASK'
  uv?: [number, number, number, number]
  y?: number
  animate?: boolean
}

/** A skinned quad strip over the 3-joint chain (vertex i weighted to joint i % 3 by name), optionally animated. */
async function piece(o: PieceOpts): Promise<Document> {
  const doc = new Document()
  const buf = doc.createBuffer()
  const scene = doc.createScene()
  const order = o.order ?? JOINTS
  const nodes = new Map<string, Node>()
  // the chain (rest: each joint 0.5 m above its parent), created in chain order whatever the skin order
  for (const [i, name] of JOINTS.entries()) {
    const n = doc.createNode(name).setTranslation([0, i === 0 ? 1 : 0.5, 0])
    if (i === 0) scene.addChild(n)
    else nodes.get(JOINTS[i - 1]!)!.addChild(n)
    nodes.set(name, n)
  }
  const skinJoints = order.map(n => nodes.get(n)!)
  // inverse binds from the rest pose: joint world = translation (0, 1 + 0.5 i, 0)
  const ibm = new Float32Array(order.length * 16)
  order.forEach((name, j) => {
    const i = JOINTS.indexOf(name)
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -(1 + 0.5 * i), 0, 1], j * 16)
  })
  const skin = doc.createSkin().setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buf)).setSkeleton(nodes.get('Bip01')!)
  for (const j of skinJoints) skin.addJoint(j)
  const y0 = o.y ?? 0.9
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  const jnt: number[] = []
  const wgt: number[] = []
  const [u0, v0, u1, v1] = o.uv ?? [0.1, 0.1, 0.9, 0.9]
  for (let i = 0; i < 6; i++) {
    const x = i % 2 ? 0.2 : -0.2
    const yy = y0 + Math.floor(i / 2) * 0.4
    pos.push(x, yy, 0)
    nrm.push(0, 0, 2) // not unit: the dresser normalises
    uv.push(i % 2 ? u1 : u0, v0 + ((v1 - v0) * Math.floor(i / 2)) / 2)
    const name = JOINTS[Math.floor(i / 2)]!
    jnt.push(order.indexOf(name), 0, 0, 0)
    wgt.push(1, 0, 0, 0)
  }
  const acc = (type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR', a: Float32Array | Uint16Array) => doc.createAccessor().setType(type).setArray(a).setBuffer(buf)
  const tex = doc.createTexture().setImage(await png(64, 32, (x, y) => [x * 4, y * 8, 128, o.alpha === 'MASK' && x < 8 ? 0 : 200])).setMimeType('image/png')
  const mat = doc.createMaterial(`${o.name}_mat`).setBaseColorTexture(tex).setAlphaMode(o.alpha ?? 'OPAQUE')
    .setDoubleSided(!!o.doubleSided).setEmissiveFactor(o.emissive ?? [0, 0, 0])
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(pos)))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(nrm)))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(uv)))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint16Array(jnt)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array(wgt)))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5])))
    .setMaterial(mat)
  scene.addChild(doc.createNode(o.name).setMesh(doc.createMesh(o.name).addPrimitive(prim)).setSkin(skin))
  if (o.animate) {
    const anim = doc.createAnimation('BEND')
    const s = Math.sin(Math.PI / 8)
    const c = Math.cos(Math.PI / 8)
    const sampler = doc.createAnimationSampler()
      .setInput(acc('SCALAR', new Float32Array([0, 1, 2])))
      .setOutput(acc('VEC4', new Float32Array([0, 0, 0, 1, s, 0, 0, c, 0, 0, 0, 1])))
      .setInterpolation('LINEAR')
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(nodes.get('Bip01 Spine')!).setTargetPath('rotation').setSampler(sampler))
    const lift = doc.createAnimationSampler()
      .setInput(acc('SCALAR', new Float32Array([0, 1, 2])))
      .setOutput(acc('VEC3', new Float32Array([0, 1, 0, 0, 1.2, 0, 0, 1, 0])))
      .setInterpolation('LINEAR')
    anim.addSampler(lift).addChannel(doc.createAnimationChannel().setTargetNode(nodes.get('Bip01')!).setTargetPath('translation').setSampler(lift))
  }
  return doc
}

/** Skins vertex `i` of a dressed doc with the VAT row `frame` (column-major matrices). */
function skinned(doc: Document, texels: Float32Array | Uint16Array, width: number, frame: number, i: number): number[] {
  const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
  const p = prim.getAttribute('POSITION')!.getElement(i, [])
  const j = prim.getAttribute('JOINTS_0')!.getElement(i, [])
  const w = prim.getAttribute('WEIGHTS_0')!.getElement(i, [])
  const out = [0, 0, 0]
  for (let k = 0; k < 4; k++) {
    if (!w[k]) continue
    const m = vatMatrix(texels, width, frame, j[k]!)
    for (let r = 0; r < 3; r++) out[r] = out[r]! + w[k]! * (m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!)
  }
  return out
}

// ---- tests -----------------------------------------------------------------------------------------------------------

describe('town atlas (TL-V)', () => {
  const img = (w: number, h: number): RgbaImage => {
    const data = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x, y, 7, 100], (y * w + x) * 4)
    return { width: w, height: h, data }
  }

  it('packs tallest first into the smallest atlas that fits, and refuses what does not', () => {
    const at = packShelves([{ key: 'a', w: 512, h: 256 }, { key: 'b', w: 256, h: 256 }, { key: 'c', w: 256, h: 128 }], 1024, 512)!
    expect(at.get('a')).toEqual({ x: 0, y: 0 })
    expect(at.get('b')).toEqual({ x: 512, y: 0 })
    expect(at.get('c')).toEqual({ x: 768, y: 0 })
    expect(packShelves([{ key: 'a', w: 600, h: 10 }], 512, 512)).toBeNull()
    expect(packShelves([{ key: 'a', w: 512, h: 300 }, { key: 'b', w: 512, h: 300 }], 512, 512)).toBeNull()
  })

  it('a full-texture source is one exact tile; a partial one is cropped with a repeated gutter', () => {
    const full: AtlasSource = { key: 'f', image: img(64, 32), opaque: false, uv: [0.005, 0.01, 0.99, 0.99] }
    expect(sourceRect(full)).toEqual({ sx: 0, sy: 0, w: 64, h: 32 })
    const part: AtlasSource = { key: 'p', image: img(64, 32), opaque: false, uv: [0.25, 0.5, 0.5, 0.75] }
    expect(sourceRect(part)).toEqual({ sx: 16 - GUTTER, sy: 16 - GUTTER, w: 16 + 2 * GUTTER, h: 8 + 2 * GUTTER })
    // past 1 (the women's clothes_03_la reaches u 1.086): the rectangle carries the repeated texels
    const wrap: AtlasSource = { key: 'w', image: img(64, 32), opaque: false, uv: [0.02, 0.1, 1.086, 0.9] }
    expect(sourceRect(wrap).w).toBe(Math.ceil(1.086 * 64) + GUTTER - (1 - GUTTER))
  })

  it('every source texel lands where atlasUv says, repeated past the edge, alpha 255 when opaque', () => {
    const a: AtlasSource = { key: 'a', image: img(64, 32), opaque: true, uv: [0.02, 0.1, 1.086, 0.9] }
    const b: AtlasSource = { key: 'b', image: img(32, 32), opaque: false, uv: [0.25, 0.25, 0.75, 0.75] }
    const atlas = buildAtlas([a, b])!
    expect(atlas).not.toBeNull()
    const read = (u: number, v: number) => {
      const x = Math.floor(u * atlas.width)
      const y = Math.floor(v * atlas.height)
      return [...atlas.image.data.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4)]
    }
    for (const [src, [u, v]] of [[a, [0.5, 0.5]], [a, [1.05, 0.2]], [a, [0.02, 0.89]], [b, [0.3, 0.6]]] as const) {
      const p = atlas.placements.get(src.key)!
      // a texel centre of the source
      const tu = (Math.floor(u * src.image.width) + 0.5) / src.image.width
      const tv = (Math.floor(v * src.image.height) + 0.5) / src.image.height
      const [au, av] = atlasUv(p, atlas.width, atlas.height, tu, tv)
      const sx = Math.floor(tu * src.image.width) % src.image.width
      const sy = Math.floor(tv * src.image.height)
      expect(read(au, av)).toEqual([sx, sy, 7, src.opaque ? 255 : 100])
    }
  })

  it('moves triangles by whole tiles towards 0..1 and keeps the source vertices first, in order', () => {
    const g = {
      pos: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      nrm: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uv: [0.1, 0.1, 0.9, 0.1, 0.1, 1.9, 0.9, 1.9],
      joints: new Array(16).fill(0),
      weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      // triangle 0 in tile v 0; triangle 1 entirely in tile v 1 (shares vertices 1 and 2 with triangle 0)
      indices: [0, 1, 2, 1, 3, 2],
    }
    g.uv[2 * 2 + 1] = 1.05
    g.uv[1 * 2 + 1] = 1.02
    normaliseTiles(g)
    // triangle 0 starts in tile 0 (min v 0.1): unchanged; triangle 1's min v is 1.02: moved by one tile
    expect(g.uv.slice(0, 8)).toEqual([0.1, 0.1, 0.9, 1.02, 0.1, 1.05, 0.9, 0.8999999999999999])
    expect(g.pos.length / 3).toBe(6)
    expect(g.indices.slice(0, 3)).toEqual([0, 1, 2])
    const t1 = g.indices.slice(3)
    for (const i of t1) expect(g.uv[i * 2 + 1]!).toBeLessThanOrEqual(1)
    expect(t1).toContain(3)
  })
})

describe('town VAT (TL-V)', () => {
  it('half floats: exact values, round to nearest even, the 1–2 m step, subnormals, overflow', () => {
    expect(toHalf(1)).toBe(0x3c00)
    expect(toHalf(-2)).toBe(0xc000)
    expect(toHalf(65504)).toBe(0x7bff)
    expect(toHalf(1e6)).toBe(0x7c00)
    expect(toHalf(0)).toBe(0)
    expect(fromHalf(toHalf(2 ** -24))).toBe(2 ** -24)
    // halfway between 1 and 1 + 2^-10 rounds to the even (1); a hair above rounds up
    expect(toHalf(1 + 2 ** -11)).toBe(0x3c00)
    expect(toHalf(1 + 2 ** -11 + 2 ** -20)).toBe(0x3c01)
    expect(toHalf(1 + 3 * 2 ** -11)).toBe(0x3c02)
    for (const v of [0.1, -0.333, 1.4567, 1.99, 0.0001]) {
      const back = fromHalf(toHalf(v))
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -11 + 1e-12)
    }
    // between 1 and 2 m a half float steps 2^-10 m (0.98 mm): the budget's 3 mm after quantisation (F11)
    expect(fromHalf(toHalf(1.5) + 1) - 1.5).toBeCloseTo(2 ** -10, 12)
  })

  it('bakes Babylon\'s layout: (joints + 1) × 4 texels a row, the identity last, rows over the true length', async () => {
    const doc = await piece({ name: 'body', animate: true })
    const skel = skeletonOf('chain', doc)
    const v = bakeVat(skel, [
      { name: 'BEND', doc, anim: 'BEND', loop: true, loopM: 1.7, source: 'synthetic#BEND' },
      { name: 'SLOW', doc, anim: 'BEND', fps: 15, loop: false, source: 'synthetic#BEND' },
    ])
    expect(v.width).toBe((3 + 1) * 4)
    expect(clipFrames(2, 30)).toBe(61)
    expect(v.clips.BEND).toMatchObject({ start: 0, end: 60, frames: 61, durationS: 2, loop: true, loopM: 1.7, walkMps: 0.85 })
    expect(v.clips.BEND!.fps).toBeCloseTo(61 / 2, 9)
    expect(v.clips.BEND!.sampleFps).toBeCloseTo(30, 9)
    expect(v.clips.SLOW).toMatchObject({ start: 61, end: 91, frames: 31, loopM: 0 })
    expect(v.clips.SLOW!.walkMps).toBeUndefined()
    // the root only rises and falls: no travel on the ground
    expect(v.clips.BEND!.rootTravelM).toBe(0)
    expect(v.height).toBe(92)
    // the identity after the joints, every row
    for (const row of [0, 37, 91]) expect([...vatMatrix(v.data, v.width, row, 3)]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    // t = 1 s (row 30): the spine bent 22.5° about x and the root lifted 0.2 m; the spine's skin matrix maps its bind
    // origin (0, 1.5, 0) to the bent joint's position
    const m = vatMatrix(v.data, v.width, 30, 1)
    const p = [m[4]! * 1.5 + m[12]!, m[5]! * 1.5 + m[13]!, m[6]! * 1.5 + m[14]!]
    expect(p[1]).toBeCloseTo(1.7, 5)
    expect(p[2]).toBeCloseTo(0, 5)
    // the loop's last row repeats its first
    expect([...vatMatrix(v.data, v.width, 60, 1)].map(x => +x.toFixed(4))).toEqual([...vatMatrix(v.data, v.width, 0, 1)].map(x => +x.toFixed(4)))
    const file = vatFile(v, 'chain.bin')
    expect(file).toMatchObject({ format: 'sro-town-vat', bones: 3, frames: 92, halfFloat: true, bytes: 16 * 92 * 4 * 2 })
    const half = encodeHalf(v.data)
    expect(half.length).toBe(v.data.length)
  })

  it('an overlay clip takes its base\'s pose where it animates nothing (STAND3 on STAND1)', async () => {
    const doc = await piece({ name: 'body', animate: true })
    // OVER animates only the head: the spine follows BEND (the base)
    const anim = doc.createAnimation('OVER')
    const buf = doc.getRoot().listBuffers()[0]!
    const sampler = doc.createAnimationSampler()
      .setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 2])).setBuffer(buf))
      .setOutput(doc.createAccessor().setType('VEC4').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1])).setBuffer(buf))
    const head = doc.getRoot().listNodes().find(n => n.getName() === 'Bip01 Head')!
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(head).setTargetPath('rotation').setSampler(sampler))
    const skel = skeletonOf('chain', doc)
    const layered = bakeVat(skel, [{ name: 'STAND3', doc, anim: 'OVER', base: 'BEND', loop: true, source: 's' }])
    const base = bakeVat(skel, [{ name: 'BEND', doc, anim: 'BEND', loop: true, source: 's' }])
    for (const row of [0, 30, 45]) expect([...vatMatrix(layered.data, layered.width, row, 1)]).toEqual([...vatMatrix(base.data, base.width, row, 1)])
  })
})

describe('town dresser (TL-V)', () => {
  it('one mesh, one material, one skin; joints remapped by name; the retail emissive zeroed as selfLit', async () => {
    const body = await piece({ name: 'body', animate: true })
    const skel = skeletonOf('chain', body)
    // the same garment twice: once in the body's joint order, once with its skin listing the joints reversed
    const coat = await piece({ name: 'coat', y: 1.0, emissive: [0.588, 0.588, 0.588] })
    const coatReordered = await piece({ name: 'coat', y: 1.0, emissive: [0.588, 0.588, 0.588], order: [...JOINTS].reverse() })
    const a = await dressVariant('a', skel, [{ label: 'body', doc: body, meshes: null }, { label: 'coat', doc: coat, meshes: null }])
    const b = await dressVariant('b', skel, [{ label: 'body', doc: body, meshes: null }, { label: 'coat', doc: coatReordered, meshes: null }])
    for (const v of [a, b]) {
      const root = v.doc.getRoot()
      expect(root.listMeshes()).toHaveLength(1)
      expect(root.listMeshes()[0]!.listPrimitives()).toHaveLength(1)
      expect(root.listMaterials()).toHaveLength(1)
      expect(root.listSkins()).toHaveLength(1)
      expect(root.listAnimations()).toHaveLength(0)
      expect(root.listSkins()[0]!.listJoints().map(j => j.getName())).toEqual(JOINTS)
      const mat = root.listMaterials()[0]!
      expect(mat.getEmissiveFactor()).toEqual([0, 0, 0])
      expect(mat.getBaseColorTexture()?.getMimeType()).toBe('image/png')
      // half the vertices carried 0.588: the vertex-weighted retail emissive
      expect(v.selfLit[0]).toBeCloseTo(0.294, 3)
      expect(v.triangles).toBe(8)
      // normals normalised
      const nrm = root.listMeshes()[0]!.listPrimitives()[0]!.getAttribute('NORMAL')!
      expect(Math.hypot(...nrm.getElement(0, []))).toBeCloseTo(1, 6)
    }
    const v = bakeVat(skel, [{ name: 'BEND', doc: body, anim: 'BEND', loop: true, source: 's' }])
    for (const row of [0, 15, 30, 59]) {
      for (let i = 0; i < a.vertices; i++) {
        const pa = skinned(a.doc, v.data, v.width, row, i)
        const pb = skinned(b.doc, v.data, v.width, row, i)
        for (let k = 0; k < 3; k++) expect(pb[k]).toBeCloseTo(pa[k]!, 9)
      }
    }
    // the coat's head vertices follow the head joint, not whatever joint index 2 was in its own skin
    const coatHead = a.parts.find(p => p.label === 'coat')!.start + 4
    const jb = b.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('JOINTS_0')!.getElement(coatHead, [])
    expect(JOINTS[jb[0]!]).toBe('Bip01 Head')
  })

  it('mirrors double-sided pieces when the rest is single-sided; keeps one double-sided material otherwise', async () => {
    const body = await piece({ name: 'body' })
    const skel = skeletonOf('chain', body)
    const hair = await piece({ name: 'hair', doubleSided: true, alpha: 'MASK', y: 1.6 })
    const v = await dressVariant('h', skel, [{ label: 'body', doc: body, meshes: null }, { label: 'hair', doc: hair, meshes: null }])
    expect(v.doubleSided).toBe(false)
    expect(v.alphaMode).toBe('MASK')
    expect(v.triangles).toBe(4 + 4 + 4)
    expect(v.parts.find(p => p.label === 'hair')!.mirrored).toBe(true)
    const mat = v.doc.getRoot().listMaterials()[0]!
    expect(mat.getDoubleSided()).toBe(false)
    expect(mat.getAlphaMode()).toBe('MASK')
    // the mirror's normals point the other way and its winding is reversed
    const prim = v.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
    const n = prim.getAttribute('NORMAL')!
    expect(n.getElement(6, [])[2]).toBeCloseTo(1, 6)
    expect(n.getElement(12, [])[2]).toBeCloseTo(-1, 6)
    const allDouble = await dressVariant('d', skel, [{ label: 'hair', doc: hair, meshes: null }])
    expect(allDouble.doubleSided).toBe(true)
    expect(allDouble.triangles).toBe(4)
  })

  it('refuses a part bound otherwise (the shared VAT would be wrong) and a joint the skeleton lacks', async () => {
    const body = await piece({ name: 'body' })
    const skel = skeletonOf('chain', body)
    const other = await piece({ name: 'odd' })
    const ibm = other.getRoot().listSkins()[0]!.getInverseBindMatrices()!
    const arr = ibm.getArray()! as Float32Array
    arr[13] = arr[13]! + 0.01
    await expect(dressVariant('x', skel, [{ label: 'odd', doc: other, meshes: null }])).rejects.toThrow(/inverse bind of Bip01 differs/)
    const alien = await piece({ name: 'alien' })
    alien.getRoot().listSkins()[0]!.listJoints()[2]!.setName('Bip01 Tail')
    await expect(dressVariant('y', skel, [{ label: 'alien', doc: alien, meshes: null }])).rejects.toThrow(/Bip01 Tail/)
  })
})

describe('town catalog (TL-V)', () => {
  it('9 + 9 people ranked 5 / 7 / 9 per gender, the guards, elders and animals, unique ids', () => {
    for (const g of ['male', 'female'] as const) {
      const p = TOWN_PEOPLE.filter(x => x.gender === g)
      expect(p).toHaveLength(9)
      expect(p.filter(x => x.rank === 'medium')).toHaveLength(5)
      expect(p.filter(x => x.rank !== 'ultra')).toHaveLength(7)
      for (const x of p) expect(x.items.every(c => c.startsWith(`ITEM_CH_${g === 'male' ? 'M' : 'W'}_`))).toBe(true)
    }
    const ids = [...TOWN_PEOPLE, ...TOWN_MODELS].map(x => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    // TOWN_LIFE §8.2: Medium draws 10 people + 2 guards + 3 animal kinds
    expect(TOWN_MODELS.filter(m => m.rank === 'medium').map(m => crowdKindOf(m)).sort()).toEqual(['cat', 'chicken', 'dog', 'guard', 'guard'])
  })

  it('the people clips leave out the qigong holds and EMOTION03, layer STAND3 and carry the town clips', () => {
    for (const g of ['male', 'female'] as const) {
      const names = peopleClips(g).map(c => c.name)
      expect(names).not.toContain('WAIT01')
      expect(names).not.toContain('EMOTION03')
      for (const n of ['STAND1', 'WALK', 'SIT', 'VENDOR01', 'EMOTION01', 'EMOTION02', 'EMOTION04', 'EMOTION07', 'SIT_CHAIR', 'CARRY', 'TALK', 'SWEEP', 'STAND1@fighter', 'WALK@fighter']) expect(names).toContain(n)
      expect(peopleClips(g).find(c => c.name === 'STAND3')!.base).toBe('STAND1')
      expect(peopleClips(g).find(c => c.name === 'VENDOR01')!.fps).toBe(15)
    }
  })
})
