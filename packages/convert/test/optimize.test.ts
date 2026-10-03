/**
 * Download-size optimizer (packages/convert/src/optimize) on synthetic, non-game assets:
 * animation packs (dedup, split, lossless round trip, retarget names), geometry quantization error,
 * the WebP quality gate, and reference rewriting.
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { Document, type Node } from '@gltf-transform/core'
import { buildPacks, compareClips, finishPack, stripAnimations } from '../src/optimize/anim.ts'
import { CHARACTER_GEOMETRY, geometryError, optimizeGeometry } from '../src/optimize/geometry.ts'
import { gltfIO } from '../src/optimize/io.ts'
import { clipHash } from '../src/optimize/measure.ts'
import { rewriteRefs } from '../src/optimize/run.ts'
import { validateGlb } from '../src/gltf/validate.ts'
import { compareImages, decodeRgba, toWebp } from '../src/optimize/texture.ts'
import { texturesToWebp } from '../src/optimize/textures-doc.ts'

const prim0 = (d: Document) => d.getRoot().listMeshes()[0]!.listPrimitives()[0]!

const JOINTS = ['Bip01', 'Bip01 Spine', 'Bip01 R Hand']

/** A 2 m tube skinned to a 3-joint chain, with the given clips ({name, seed} -> rotation keys on every joint). */
function character(clips: { name: string; seed: number; partial?: boolean }[]): Document {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene()
  const joints: Node[] = []
  JOINTS.forEach((name, i) => {
    const n = doc.createNode(name).setTranslation([0, i === 0 ? 0 : 0.8, 0])
    if (i === 0) scene.addChild(n)
    else joints[i - 1]!.addChild(n)
    joints.push(n)
  })
  const pos: number[] = []
  const nrm: number[] = []
  const jnt: number[] = []
  const wgt: number[] = []
  const idx: number[] = []
  const rings = 9
  const sides = 12
  for (let r = 0; r < rings; r++) {
    const y = (2 * r) / (rings - 1)
    for (let s = 0; s < sides; s++) {
      const a = (2 * Math.PI * s) / sides
      pos.push(0.15 * Math.cos(a) + 0.0123456, y, 0.15 * Math.sin(a) - 0.0654321)
      nrm.push(Math.cos(a), 0, Math.sin(a))
      const j = Math.min(2, Math.floor(y / 0.8))
      const f = y / 0.8 - j
      jnt.push(j, Math.min(2, j + 1), 0, 0)
      wgt.push(1 - f * 0.37, f * 0.37, 0, 0)
    }
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s
      const b = r * sides + ((s + 1) % sides)
      idx.push(a, a + sides, b, b, a + sides, b + sides)
    }
  }
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(jnt)).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(wgt)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer))
  const mesh = doc.createMesh('tube').addPrimitive(prim)
  const ibm: number[] = []
  JOINTS.forEach((_n, i) => ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.8 * i, 0, 1))
  const skin = doc.createSkin().setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(new Float32Array(ibm)).setBuffer(buffer))
  for (const j of joints) skin.addJoint(j)
  scene.addChild(doc.createNode('body').setMesh(mesh).setSkin(skin))
  for (const c of clips) {
    const anim = doc.createAnimation(c.name)
    const targets = c.partial ? joints.slice(2) : joints
    for (const [ji, j] of targets.entries()) {
      const times = new Float32Array([0, 0.5, 1])
      const q: number[] = []
      for (const t of times) {
        const a = 0.3 * Math.sin(c.seed + t * 3 + ji)
        q.push(Math.sin(a / 2), 0, 0, Math.cos(a / 2))
      }
      const s = doc.createAnimationSampler()
        .setInput(doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer))
        .setOutput(doc.createAccessor().setType('VEC4').setArray(new Float32Array(q)).setBuffer(buffer))
      anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(j).setTargetPath('rotation').setSampler(s))
    }
  }
  return doc
}

describe('animation packs', () => {
  it('dedups identical clips, splits by group and round-trips losslessly through meshopt', async () => {
    const io = await gltfIO()
    const a = character([
      { name: 'STAND1', seed: 1 },
      { name: 'RUN', seed: 2 },
      { name: 'RUN_sword', seed: 3 },
      { name: 'RUN_spear', seed: 3 },
      { name: 'DAMAGE1', seed: 4, partial: true },
    ])
    const b = character([
      { name: 'STAND1', seed: 1 },
      { name: 'SHOOT_bow', seed: 5 },
      { name: 'RUN', seed: 2 },
    ])
    const sideA = [
      { name: 'STAND1', group: 'default', banName: 'stand' },
      { name: 'RUN', group: 'default', banName: 'run' },
      { name: 'RUN_sword', group: 'sword', banName: 'run_weapon' },
      { name: 'RUN_spear', group: 'spear', banName: 'run_weapon' },
      { name: 'DAMAGE1', group: 'default', banName: 'damage', partial: true },
    ]
    const sideB = [
      { name: 'STAND1', group: 'default', banName: 'stand' },
      { name: 'SHOOT_bow', group: 'bow', banName: 'shoot' },
      { name: 'RUN', group: 'default', banName: 'run' },
    ]
    const originals = [await io.readBinary(await io.writeBinary(a)), await io.readBinary(await io.writeBinary(b))]
    const build = buildPacks([
      { rel: 'char/t/a.glb', doc: a, animations: sideA, bsk: 'prim\\skel\\test_skel.bsk' },
      { rel: 'char/t/b.glb', doc: b, animations: sideB, bsk: 'prim\\skel\\test_skel.bsk' },
    ])
    expect([...build.packs.keys()].sort()).toEqual([
      'char/_anims/test_skel/bow.glb',
      'char/_anims/test_skel/default.glb',
      'char/_anims/test_skel/spear.glb',
      'char/_anims/test_skel/sword.glb',
    ])
    expect(build.stats.clips).toBe(8)
    expect(build.stats.uniqueClips).toBe(5)
    const ia = build.index.get('char/t/a.glb')!
    expect(ia.clips.STAND1).toEqual(['default', 'stand'])
    expect(ia.clips.RUN_sword).toEqual(['sword', 'run_weapon'])
    expect(ia.clips.RUN_spear).toEqual(['spear', 'run_weapon'])
    expect(Object.keys(ia.packs).sort()).toEqual(['default', 'spear', 'sword'])
    expect(build.index.get('char/t/b.glb')!.clips.SHOOT_bow).toEqual(['bow', 'shoot'])

    const packs = new Map<string, Document>()
    for (const [rel, doc] of build.packs) {
      await finishPack(doc)
      const glb = await io.writeBinary(doc)
      const back = await io.readBinary(glb)
      expect(back.getRoot().listExtensionsUsed().map(e => e.extensionName)).toContain('EXT_meshopt_compression')
      expect(back.getRoot().listMeshes()).toHaveLength(0)
      expect(back.getRoot().listNodes().map(n => n.getName())).toEqual(JOINTS)
      packs.set(rel, back)
    }
    for (const [i, rel] of ['char/t/a.glb', 'char/t/b.glb'].entries()) {
      const idx = build.index.get(rel)!
      for (const anim of originals[i]!.getRoot().listAnimations()) {
        const [group, name] = idx.clips[anim.getName()]!
        const packClip = packs.get(idx.packs[group]!)!.getRoot().listAnimations().find(x => x.getName() === name)!
        const cmp = compareClips(anim, packClip)
        expect(cmp.maxDiff).toBe(0)
        expect(cmp.missing).toEqual([])
        expect(cmp.extra).toEqual([])
        expect(clipHash(packClip)).toBe(clipHash(anim))
      }
    }
    // The partial clip keeps only its own channel.
    const dmg = packs.get('char/_anims/test_skel/default.glb')!.getRoot().listAnimations().find(x => x.getName() === 'damage')!
    expect(dmg.listChannels().map(c => c.getTargetNode()!.getName())).toEqual(['Bip01 R Hand'])

    await stripAnimations(a)
    expect(a.getRoot().listAnimations()).toHaveLength(0)
    expect(a.getRoot().listSkins()[0]!.listJoints()).toHaveLength(3)
  })
})

describe('geometry', () => {
  it('keeps skinned positions and inverse binds exact, quantizes weights with sub-millimetre posed error', async () => {
    const io = await gltfIO()
    const src = character([{ name: 'STAND1', seed: 1 }])
    const original = await io.readBinary(await io.writeBinary(src))
    const ibmBefore = [...original.getRoot().listSkins()[0]!.getInverseBindMatrices()!.getArray()!]
    const { positionsQuantized } = await optimizeGeometry(src, CHARACTER_GEOMETRY)
    expect(positionsQuantized).toBe(false)
    const back = await io.readBinary(await io.writeBinary(src))
    // int16 normals need KHR_mesh_quantization (quantize() alone would only declare it for POSITION).
    expect(back.getRoot().listExtensionsRequired().map(e => e.extensionName).sort()).toEqual(['EXT_meshopt_compression', 'KHR_mesh_quantization'])
    expect(prim0(back).getAttribute('NORMAL')!.getComponentSize()).toBe(2)
    expect((await validateGlb(await io.writeBinary(back))).errors).toBe(0)
    expect(back.getRoot().listSkins()).toHaveLength(1)
    expect([...back.getRoot().listSkins()[0]!.getInverseBindMatrices()!.getArray()!]).toEqual(ibmBefore)
    const prim = back.getRoot().listMeshes()[0]!.listPrimitives()[0]!
    expect(prim.getAttribute('POSITION')!.getComponentSize()).toBe(4)
    expect(prim.getAttribute('WEIGHTS_0')!.getComponentSize()).toBe(2)
    const pose = new Map([['Bip01 Spine', { r: [Math.sin(0.4), 0, 0, Math.cos(0.4)] }], ['Bip01 R Hand', { r: [0, 0, Math.sin(0.3), Math.cos(0.3)] }]])
    // Only the uint16 weights (sum within 1/65535 of 1) move anything at the bind pose.
    expect(geometryError(original, back).maxPositionMm).toBeLessThan(0.001)
    const err = geometryError(original, back, [pose])
    expect(err.unmatchedPrimitives).toEqual([])
    expect(err.vertices).toBe(108)
    expect(err.maxPositionMm).toBeLessThan(0.05)
  })

  it('quantizes static positions onto the node transform with sub-millimetre error', async () => {
    const io = await gltfIO()
    const src = character([])
    for (const s of src.getRoot().listSkins()) s.dispose()
    const body = src.getRoot().listNodes().find(n => n.getName() === 'body')!
    body.setTranslation([10, 2, -30])
    const original = await io.readBinary(await io.writeBinary(src))
    const { positionsQuantized } = await optimizeGeometry(src, CHARACTER_GEOMETRY)
    expect(positionsQuantized).toBe(true)
    const back = await io.readBinary(await io.writeBinary(src))
    expect(back.getRoot().listNodes().map(n => n.getName())).toEqual(original.getRoot().listNodes().map(n => n.getName()))
    expect(back.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!.getComponentSize()).toBe(2)
    const err = geometryError(original, back)
    expect(err.maxPositionMm).toBeGreaterThan(0)
    expect(err.maxPositionMm).toBeLessThan(0.2)
  })
})

describe('textures', () => {
  it('passes the gate on a synthetic texture and measures identity as Infinity', async () => {
    const w = 128
    const h = 64
    const raw = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4
        raw[p] = (x * 2) & 255
        raw[p + 1] = (y * 4) & 255
        raw[p + 2] = ((x ^ y) * 3) & 255
        raw[p + 3] = x < 8 ? 0 : 255
      }
    }
    const png = new Uint8Array(await sharp(Buffer.from(raw), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer())
    const img = await decodeRgba(png)
    expect(compareImages(img, img)).toEqual({ psnr: Infinity, ssim: 1, alphaPsnr: Infinity })
    const r = await toWebp(png)
    expect(r.flagged).toBe(false)
    expect(r.psnr).toBeGreaterThanOrEqual(35)
    expect(r.ssim).toBeGreaterThanOrEqual(0.98)
    expect(r.alphaPsnr).toBe(Infinity)
    const again = compareImages(img, await decodeRgba(r.webp))
    expect(again.psnr).toBeCloseTo(r.psnr, 6)

    const doc = new Document()
    doc.createBuffer()
    doc.createMaterial('m').setBaseColorTexture(doc.createTexture('t').setImage(png).setMimeType('image/png'))
    const recs = await texturesToWebp(doc)
    expect(recs).toHaveLength(1)
    const io = await gltfIO()
    const back = await io.readBinary(await io.writeBinary(doc))
    expect(back.getRoot().listTextures()[0]!.getMimeType()).toBe('image/webp')
    expect(back.getRoot().listExtensionsRequired().map(e => e.extensionName)).toContain('EXT_texture_webp')
  })
})

describe('reference rewriting', () => {
  it('rewrites only strings that resolve to a renamed file', () => {
    const renamed = new Map([
      ['world/jangan/lightmaps/prim/a.png', 'world/jangan/lightmaps/prim/a.webp'],
      ['world/jangan/tiles/t.png', 'world/jangan/tiles/t.webp'],
    ])
    const { value, count } = rewriteRefs({
      tiles: [{ file: 'tiles/t.png' }, { file: 'tiles/missing.png' }],
      sroLightmap: { uri: 'lightmaps/prim/a.png', path: 'prim\\lightmap\\a.ddj' },
      other: 'ui/x.png',
    }, 'world/jangan/manifest.json', renamed)
    expect(count).toBe(2)
    expect(value).toEqual({
      tiles: [{ file: 'tiles/t.webp' }, { file: 'tiles/missing.png' }],
      sroLightmap: { uri: 'lightmaps/prim/a.webp', path: 'prim\\lightmap\\a.ddj' },
      other: 'ui/x.png',
    })
    // From a model glb deeper in the tree, uris are relative to the world folder.
    expect(rewriteRefs('lightmaps/prim/a.png', 'world/jangan/models/bldg/x.glb', renamed).value).toBe('lightmaps/prim/a.webp')
  })
})
