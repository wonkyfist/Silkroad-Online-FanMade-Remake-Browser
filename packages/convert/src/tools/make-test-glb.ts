#!/usr/bin/env node
// Writes synthetic (non-game) assets for the viewer to work/out/test/ and merges them into
// work/out/index.json:
//   skinned-test.glb/.json  a tube skinned to a 3-joint chain with two animations, plus a
//                           sidecar with fake animation events (type 1 = hit, 2 = footstep)
//   test-blade.glb          a small static mesh to try "attach to bone" with
// Usage: pnpm exec tsx packages/convert/src/tools/make-test-glb.ts [--out <dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document, NodeIO, type Accessor, type Buffer as GltfBuffer } from '@gltf-transform/core'
import { REPO_ROOT, loadConfig } from '../node-io.ts'

export interface IndexEntry {
  id: string
  name: string
  category: string
  glb: string
  sidecar?: string
}

const JOINTS = [
  { name: 'Bip01', y: 0 },
  { name: 'Bip01 Spine', y: 0.8 },
  { name: 'Bip01 R Hand', y: 1.6 },
]
const HEIGHT = 2
const RADIUS = 0.15
const SIDES = 12
const RINGS = 9

function outDirFromArgs(): string {
  const i = process.argv.indexOf('--out')
  if (i >= 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]!)
  const workDir = existsSync(join(REPO_ROOT, 'sro.config.json')) ? loadConfig().workDir : join(REPO_ROOT, 'work')
  return join(workDir, 'out')
}

function quatAxisAngle(axis: [number, number, number], angle: number): number[] {
  const s = Math.sin(angle / 2)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]
}

function accessor(doc: Document, buffer: GltfBuffer, type: 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4',
  array: Float32Array | Uint16Array | Uint32Array): Accessor {
  return doc.createAccessor().setType(type).setArray(array).setBuffer(buffer)
}

/** Weights along the chain: rigid spans around each joint, linear blends of 0.4 across the joint boundaries. */
function skinWeights(y: number): [number, number, number] {
  const blend = (t: number) => Math.min(1, Math.max(0, t))
  if (y < 0.6) return [1, 0, 0]
  if (y < 1.0) return [1 - blend((y - 0.6) / 0.4), blend((y - 0.6) / 0.4), 0]
  if (y < 1.4) return [0, 1, 0]
  if (y < 1.8) return [0, 1 - blend((y - 1.4) / 0.4), blend((y - 1.4) / 0.4)]
  return [0, 0, 1]
}

/** Unused influence slots point at joint 0 so the validator does not flag non-zero joints with zero weight. */
function jointIndices(w: [number, number, number]): number[] {
  return [0, w[1] > 0 ? 1 : 0, w[2] > 0 ? 2 : 0, 0]
}

function buildSkinnedTest(): Document {
  const doc = new Document()
  doc.getRoot().getAsset().generator = 'silkroad make-test-glb'
  const buffer = doc.createBuffer()

  const pos: number[] = []
  const nrm: number[] = []
  const jnt: number[] = []
  const wgt: number[] = []
  const idx: number[] = []
  const vertex = (p: number[], n: number[], w: [number, number, number]) => {
    pos.push(...p)
    nrm.push(...n)
    jnt.push(...jointIndices(w))
    wgt.push(w[0], w[1], w[2], 0)
  }
  for (let r = 0; r < RINGS; r++) {
    const y = (r / (RINGS - 1)) * HEIGHT
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2
      vertex([Math.cos(a) * RADIUS, y, Math.sin(a) * RADIUS], [Math.cos(a), 0, Math.sin(a)], skinWeights(y))
    }
  }
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * SIDES + s
      const b = r * SIDES + ((s + 1) % SIDES)
      const c = a + SIDES
      const d = b + SIDES
      // Counter-clockwise seen from outside (glTF front face).
      idx.push(a, c, b, b, c, d)
    }
  }
  // Caps: one centre vertex each, flat normals.
  for (const [y, ny] of [[0, -1], [HEIGHT, 1]] as const) {
    const w = skinWeights(y)
    const centre = pos.length / 3
    vertex([0, y, 0], [0, ny, 0], w)
    const first = pos.length / 3
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2
      vertex([Math.cos(a) * RADIUS, y, Math.sin(a) * RADIUS], [0, ny, 0], w)
    }
    for (let s = 0; s < SIDES; s++) {
      const a = first + s
      const b = first + ((s + 1) % SIDES)
      if (ny > 0) idx.push(centre, b, a)
      else idx.push(centre, a, b)
    }
  }

  const material = doc.createMaterial('TestMaterial')
    .setBaseColorFactor([0.85, 0.55, 0.25, 1]).setRoughnessFactor(0.6).setMetallicFactor(0)
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', accessor(doc, buffer, 'VEC3', new Float32Array(pos)))
    .setAttribute('NORMAL', accessor(doc, buffer, 'VEC3', new Float32Array(nrm)))
    .setAttribute('JOINTS_0', accessor(doc, buffer, 'VEC4', new Uint16Array(jnt)))
    .setAttribute('WEIGHTS_0', accessor(doc, buffer, 'VEC4', new Float32Array(wgt)))
    .setIndices(accessor(doc, buffer, 'SCALAR', new Uint16Array(idx)))
    .setMaterial(material)
  const mesh = doc.createMesh('Tube').addPrimitive(prim)

  const joints = JOINTS.map((j, i) => doc.createNode(j.name).setTranslation([0, i === 0 ? j.y : j.y - JOINTS[i - 1]!.y, 0]))
  joints[0]!.addChild(joints[1]!)
  joints[1]!.addChild(joints[2]!)
  const ibm = new Float32Array(16 * JOINTS.length)
  JOINTS.forEach((j, i) => {
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -j.y, 0, 1], i * 16)
  })
  const skin = doc.createSkin('TestSkeleton').setSkeleton(joints[0]!)
    .setInverseBindMatrices(accessor(doc, buffer, 'MAT4', ibm))
  for (const j of joints) skin.addJoint(j)
  const meshNode = doc.createNode('TubeMesh').setMesh(mesh).setSkin(skin)
  doc.createScene('Scene').addChild(joints[0]!).addChild(meshNode)

  const addRotationTrack = (animName: string, times: number[], node: number, quats: number[][]) => {
    const anim = doc.getRoot().listAnimations().find(a => a.getName() === animName) ?? doc.createAnimation(animName)
    const sampler = doc.createAnimationSampler().setInterpolation('LINEAR')
      .setInput(accessor(doc, buffer, 'SCALAR', new Float32Array(times)))
      .setOutput(accessor(doc, buffer, 'VEC4', new Float32Array(quats.flat())))
    const channel = doc.createAnimationChannel().setTargetNode(joints[node]!).setTargetPath('rotation').setSampler(sampler)
    anim.addSampler(sampler).addChannel(channel)
  }
  const z: [number, number, number] = [0, 0, 1]
  const x: [number, number, number] = [1, 0, 0]
  // "wave": 2 s, sway the spine left/right and flick the hand.
  const waveT = [0, 0.5, 1, 1.5, 2]
  addRotationTrack('wave', waveT, 1, [0, 0.6, 0, -0.6, 0].map(a => quatAxisAngle(z, a)))
  addRotationTrack('wave', waveT, 2, [0, -0.8, 0, 0.8, 0].map(a => quatAxisAngle(z, a)))
  // "bend": 1.5 s, bow forward and back up, with a translation bob on the root.
  const bendT = [0, 0.75, 1.5]
  addRotationTrack('bend', bendT, 1, [0, 0.9, 0].map(a => quatAxisAngle(x, a)))
  addRotationTrack('bend', bendT, 2, [0, 0.5, 0].map(a => quatAxisAngle(x, a)))
  const bend = doc.getRoot().listAnimations().find(a => a.getName() === 'bend')!
  const bob = doc.createAnimationSampler().setInterpolation('LINEAR')
    .setInput(accessor(doc, buffer, 'SCALAR', new Float32Array(bendT)))
    .setOutput(accessor(doc, buffer, 'VEC3', new Float32Array([0, 0, 0, 0, -0.2, 0, 0, 0, 0])))
  bend.addSampler(bob).addChannel(doc.createAnimationChannel().setTargetNode(joints[0]!).setTargetPath('translation').setSampler(bob))
  return doc
}

function buildBlade(): Document {
  const doc = new Document()
  doc.getRoot().getAsset().generator = 'silkroad make-test-glb'
  const buffer = doc.createBuffer()
  // A thin box along +Y (0..0.9) with a small cross guard, 24 vertices per box for flat normals.
  const pos: number[] = []
  const nrm: number[] = []
  const idx: number[] = []
  const box = (min: [number, number, number], max: [number, number, number]) => {
    const faces: Array<{ n: [number, number, number]; c: Array<[number, number, number]> }> = [
      { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
      { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
      { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
      { n: [0, -1, 0], c: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
      { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
      { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
    ]
    for (const f of faces) {
      const base = pos.length / 3
      for (const c of f.c) {
        pos.push(c[0] ? max[0] : min[0], c[1] ? max[1] : min[1], c[2] ? max[2] : min[2])
        nrm.push(...f.n)
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }
  box([-0.02, -0.12, -0.02], [0.02, 0.05, 0.02])
  box([-0.08, 0.05, -0.025], [0.08, 0.08, 0.025])
  box([-0.035, 0.08, -0.008], [0.035, 0.9, 0.008])
  const material = doc.createMaterial('BladeMaterial').setBaseColorFactor([0.7, 0.75, 0.8, 1]).setMetallicFactor(0.8).setRoughnessFactor(0.3)
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', accessor(doc, buffer, 'VEC3', new Float32Array(pos)))
    .setAttribute('NORMAL', accessor(doc, buffer, 'VEC3', new Float32Array(nrm)))
    .setIndices(accessor(doc, buffer, 'SCALAR', new Uint16Array(idx)))
    .setMaterial(material)
  const node = doc.createNode('Blade').setMesh(doc.createMesh('Blade').addPrimitive(prim))
  doc.createScene('Scene').addChild(node)
  return doc
}

/** Replaces entries with the same id in place, appends new ones, keeps everything else. */
export function mergeIndex(indexPath: string, entries: IndexEntry[]): IndexEntry[] {
  let existing: IndexEntry[] = []
  if (existsSync(indexPath)) {
    const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`${indexPath}: expected a JSON array`)
    existing = parsed as IndexEntry[]
  }
  const byId = new Map(entries.map(e => [e.id, e]))
  const merged = existing.map(e => {
    const replacement = byId.get(e.id)
    if (replacement) byId.delete(e.id)
    return replacement ?? e
  })
  merged.push(...byId.values())
  writeFileSync(indexPath, JSON.stringify(merged, null, 2) + '\n')
  return merged
}

async function main(): Promise<void> {
  const outDir = outDirFromArgs()
  const testDir = join(outDir, 'test')
  mkdirSync(testDir, { recursive: true })
  const io = new NodeIO()

  writeFileSync(join(testDir, 'skinned-test.glb'), await io.writeBinary(buildSkinnedTest()))
  const sidecar = {
    source: 'make-test-glb (synthetic)',
    skeleton: { joints: JOINTS.map(j => j.name) },
    animations: [
      {
        name: 'wave',
        durationMs: 2000,
        events: [
          { timeMs: 500, type: 1 },
          { timeMs: 1000, type: 2 },
          { timeMs: 1500, type: 2 },
          { timeMs: 1750, type: 3 },
        ],
      },
      { name: 'bend', durationMs: 1500, events: [{ timeMs: 750, type: 1 }, { timeMs: 1400, type: 2 }] },
    ],
  }
  writeFileSync(join(testDir, 'skinned-test.json'), JSON.stringify(sidecar, null, 2) + '\n')
  writeFileSync(join(testDir, 'test-blade.glb'), await io.writeBinary(buildBlade()))

  const merged = mergeIndex(join(outDir, 'index.json'), [
    { id: 'test/skinned-test', name: 'Skinned test (3 joints, 2 clips)', category: 'test', glb: 'test/skinned-test.glb', sidecar: 'test/skinned-test.json' },
    { id: 'test/test-blade', name: 'Test blade (static)', category: 'test', glb: 'test/test-blade.glb' },
  ])
  console.log(`wrote ${testDir} (skinned-test.glb, skinned-test.json, test-blade.glb); index.json has ${merged.length} entries`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
