import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeIO, type Document, type Node } from '@gltf-transform/core'
import { bskMath, parseBan, parseBms, parseBsk, parseBsr, type BskTransform } from '@sro/formats'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { convertMany, PRESETS, type ConvertManyResult } from '../src/gltf/output.ts'
import { toGltfPosition, type Quat, type Vec3 } from '../src/gltf/space.ts'

const { rigidApply, rigidCompose, rigidToMat4 } = bskMath
const HAS_CONFIG = existsSync(join(REPO_ROOT, 'sro.config.json'))
const CHARACTERS = ['char/china/chinaman_adventurer', 'char/china/chinawoman_adventurer', 'char/europe/europeman_adventurer']

function mat4Apply(m: ArrayLike<number>, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ]
}

function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!
  return out
}

/** Bind-pose Y extent of every POSITION accessor in the document, in metres. */
function glbHeight(doc: Document): number {
  let lo = Infinity
  let hi = -Infinity
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!.getArray()!
      for (let i = 1; i < pos.length; i += 3) {
        lo = Math.min(lo, pos[i]!)
        hi = Math.max(hi, pos[i]!)
      }
    }
  }
  return hi - lo
}

/**
 * Plain glTF skinning on the CPU: sample `animName` at `time` (LINEAR, exact key times), compose node worlds,
 * skin = sum w * world(joint) * inverseBind(joint) * p.
 */
function gltfSkinnedPositions(doc: Document, animName: string, time: number): Map<string, Float32Array> {
  const anim = doc.getRoot().listAnimations().find(a => a.getName() === animName)!
  const local = new Map<Node, BskTransform>()
  for (const node of doc.getRoot().listNodes()) {
    local.set(node, { rotation: node.getRotation() as Quat, translation: node.getTranslation() as Vec3 })
  }
  for (const ch of anim.listChannels()) {
    const s = ch.getSampler()!
    const input = s.getInput()!.getArray()!
    const output = s.getOutput()!.getArray()!
    const size = ch.getTargetPath() === 'rotation' ? 4 : 3
    let k = 0
    while (k + 1 < input.length && input[k + 1]! <= time + 1e-6) k++
    const value = Array.from(output.subarray(k * size, k * size + size))
    const t = local.get(ch.getTargetNode()!)!
    if (size === 4) t.rotation = value as Quat
    else t.translation = value as Vec3
  }
  const world = new Map<Node, number[]>()
  const worldOf = (node: Node): number[] => {
    let w = world.get(node)
    if (!w) {
      const parent = node.getParentNode()
      const m = rigidToMat4(local.get(node)!)
      w = parent ? mat4Mul(worldOf(parent), m) : m
      world.set(node, w)
    }
    return w
  }
  const out = new Map<string, Float32Array>()
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin()
    const mesh = node.getMesh()
    if (!skin || !mesh) continue
    const ibm = skin.getInverseBindMatrices()!.getArray()!
    const jointMats = skin.listJoints().map((j, i) => mat4Mul(worldOf(j), ibm.subarray(i * 16, i * 16 + 16)))
    const prim = mesh.listPrimitives()[0]!
    const pos = prim.getAttribute('POSITION')!.getArray()!
    const joints = prim.getAttribute('JOINTS_0')!.getArray()!
    const weights = prim.getAttribute('WEIGHTS_0')!.getArray()!
    const res = new Float32Array(pos.length)
    for (let v = 0; v < pos.length / 3; v++) {
      const p: Vec3 = [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!]
      for (let s = 0; s < 4; s++) {
        const w = weights[v * 4 + s]!
        if (!w) continue
        const q = mat4Apply(jointMats[joints[v * 4 + s]!]!, p)
        for (let c = 0; c < 3; c++) res[v * 3 + c]! += w * q[c]!
      }
    }
    out.set(node.getName(), res)
  }
  return out
}

describe.skipIf(!HAS_CONFIG)('BSR -> glTF (m1 preset)', () => {
  let outDir: string
  let result: ConvertManyResult
  const read = (p: string) => openArchive('Data').read(p)
  const docs = new Map<string, Document>()

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'sro-gltf-'))
    result = await convertMany(PRESETS.m1!, read, outDir)
    const io = new NodeIO()
    for (const a of result.assets) docs.set(a.entry.id, await io.readBinary(new Uint8Array(readFileSync(a.glbFile))))
  })
  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true })
  })

  it('converts every asset with zero validator errors', () => {
    expect(result.failures).toEqual([])
    expect(result.assets.map(a => a.entry.id).sort()).toEqual([
      'char/china/chinaman_adventurer', 'char/china/chinawoman_adventurer', 'char/europe/europeman_adventurer',
      'item/china/weapon/blade_01', 'mob/china/mangnyang', 'mob/china/tiger', 'mob/china/tigerwoman',
    ])
    for (const a of result.assets) {
      const warnings = a.validation.messages.filter(m => m.severity <= 1).map(m => `${m.code} ${m.pointer ?? ''}`)
      if (warnings.length) console.log(a.entry.id, warnings)
      expect(a.validation.errors, a.entry.id).toBe(0)
    }
  })

  it('writes the viewer index and sidecars', () => {
    const index = JSON.parse(readFileSync(result.indexFile, 'utf8')) as Array<{ id: string; glb: string; sidecar: string; category: string }>
    for (const a of result.assets) {
      const row = index.find(e => e.id === a.entry.id)!
      expect(row.glb).toBe(`${a.entry.id}.glb`)
      expect(row.category).toBe(a.entry.id.split('/').slice(0, -1).join('/'))
      expect(existsSync(join(outDir, row.sidecar))).toBe(true)
    }
    const man = JSON.parse(readFileSync(join(outDir, 'char/china/chinaman_adventurer.json'), 'utf8'))
    expect(man.units.metresPerUnit).toBe(0.1)
    const run = man.animations.find((x: { name: string }) => x.name === 'RUN')
    expect(run.events.length).toBeGreaterThan(0)
    expect(new Set(man.animations.map((x: { name: string }) => x.name)).size).toBe(man.animations.length)
  })

  it('characters are skinned, animated and 1.5-2.2 m tall in the bind pose', () => {
    for (const id of CHARACTERS) {
      const doc = docs.get(id)!
      const skins = doc.getRoot().listSkins()
      expect(skins.length, id).toBe(1)
      expect(skins[0]!.listJoints().length, id).toBeGreaterThan(0)
      expect(doc.getRoot().listAnimations().length, id).toBeGreaterThan(0)
      const h = glbHeight(doc)
      expect(h, id).toBeGreaterThan(1.5)
      expect(h, id).toBeLessThan(2.2)
    }
  })

  it('the weapon is a static glb with its attach bone in the sidecar', () => {
    const doc = docs.get('item/china/weapon/blade_01')!
    expect(doc.getRoot().listSkins().length).toBe(0)
    expect(doc.getRoot().listAnimations().length).toBe(0)
    const a = result.assets.find(x => x.entry.id === 'item/china/weapon/blade_01')!
    expect(a.sidecar.attachBone).toBe('Bip01 R HandMid')
    expect(a.sidecar.stats.textures).toBe(1)
  })

  it('posed glTF skinning equals skinning in Silkroad file space (chinaman RUN, every key)', () => {
    const bsrPath = 'res/char/china/chinaman_adventurer.bsr'
    const bsr = parseBsr(read(bsrPath))
    const bsk = parseBsk(read(bsr.skeleton!.path))
    const entry = bsr.aniGroups.find(g => g.name === 'default')!.animations.find(x => x.typeName === 'RUN')!
    const ban = parseBan(read(entry.path!))
    const doc = docs.get('char/china/chinaman_adventurer')!
    const tracks = new Map(ban.tracks.map(t => [t.boneName, t]))
    let maxErr = 0
    for (let k = 0; k < ban.keyTimes.length; k += 3) {
      // File space: local = BAN key (or bind toParent), world = parent o local, skin = world o stored toLocal.
      const world: BskTransform[] = []
      bsk.bones.forEach((bone, i) => {
        const t = tracks.get(bone.name)
        const local: BskTransform = t
          ? { rotation: Array.from(t.rotations.subarray(k * 4, k * 4 + 4)) as Quat, translation: Array.from(t.translations.subarray(k * 3, k * 3 + 3)) as Vec3 }
          : bone.toParent
        world[i] = bone.parentIndex >= 0 ? rigidCompose(world[bone.parentIndex]!, local) : local
      })
      const skinMats = bsk.bones.map((bone, i) => rigidCompose(world[i]!, bone.toLocal))
      const byName = new Map(bsk.bones.map((b, i) => [b.name, i]))
      const posed = gltfSkinnedPositions(doc, 'RUN', ban.keyTimes[k]! / 1000)
      for (const m of bsr.meshes) {
        const bms = parseBms(read(m.path))
        const got = posed.get(bms.name)!
        for (let v = 0; v < bms.vertexCount; v++) {
          const p: Vec3 = [bms.positions[v * 3]!, bms.positions[v * 3 + 1]!, bms.positions[v * 3 + 2]!]
          const acc: Vec3 = [0, 0, 0]
          let sum = 0
          for (let s = 0; s < 4; s++) sum += bms.weights![v * 4 + s]!
          for (let s = 0; s < 4; s++) {
            const w = bms.weights![v * 4 + s]!
            if (!w) continue
            const q = rigidApply(skinMats[byName.get(bms.boneNames[bms.joints![v * 4 + s]!]!)!]!, p)
            for (let c = 0; c < 3; c++) acc[c] += (w / sum) * q[c]!
          }
          const expected = toGltfPosition(acc)
          for (let c = 0; c < 3; c++) maxErr = Math.max(maxErr, Math.abs(expected[c]! - got[v * 3 + c]!))
        }
      }
    }
    console.log(`chinaman RUN: max |glTF - file-space| = ${maxErr.toExponential(2)} m`)
    expect(maxErr).toBeLessThan(1e-4)
  })
})
