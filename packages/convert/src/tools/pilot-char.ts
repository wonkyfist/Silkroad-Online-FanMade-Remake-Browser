#!/usr/bin/env node
// P1 stage 1: the female pilot body (docs/CHARACTERS.md §15). Takes the Blender export of the pilot (the base body split
// into regions, the degree-3 garment, two hair-card styles, body morph pairs, rigged to the retail europewoman_skel
// plus 4 jiggle bones) and writes the game's glb + sidecar:
//   pnpm tsx packages/convert/src/tools/pilot-char.ts [--in work/tmp/pilot/export/female_pilot_blender.glb]
// What it does: puts every retail joint back at the retail glb's exact rest transform (Blender's bone axes never reach
// the game) and recomputes the inverse binds, keeps the jiggle joints' world rest, sets the hair to alpha-test, drops
// emissive, re-encodes opaque textures as JPEG, checks the budgets (§2.3) and writes work/out/char/pilot/ and
// work/out-opt/char/pilot/ (the sidecar carries the retail clip index and animation packs, so every retail clip plays).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeIO, type Document, type Node as GNode } from '@gltf-transform/core'
import { REPO_ROOT } from '../node-io.ts'
import { gltfIO } from '../optimize/io.ts'
import { pilotTrackKept } from '../../../../apps/game/src/three/pilot-clip.ts'

type Mat4 = number[]

const args = process.argv.slice(2)
const flag = (k: string, d: string) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1]! : d
}
const WORK = join(REPO_ROOT, 'work')
const IN = resolve(flag('--in', join(WORK, 'tmp/pilot/export/female_pilot_blender.glb')))
const RETAIL_GLB = join(WORK, 'out/char/china/chinawoman_adventurer.glb')
const RETAIL_SIDE = join(WORK, 'out-opt/char/china/chinawoman_adventurer.json')
const PACKS = ['default', 'sword'].map(p => join(WORK, `out-opt/char/_anims/europewoman_skel/${p}.glb`))
const OUTS =[join(WORK, 'out/char/pilot'), join(WORK, 'out-opt/char/pilot')]
const JIGGLE = ['chest_L', 'chest_R', 'glute_L', 'glute_R']
/** Regions each outfit hides on the base (CHARACTERS §4.1). */
const COVERS: Record<string, string[]> = { base: [], a5: ['under'] }
/** LOD0 budgets (§2.3): body 12 k (head 4 k), outfit 14 k, hair 4 k, total 30 k. */
const BUDGET = { body: 12000, head: 4000, outfit: 14000, hair: 4000, total: 30000 }

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!
  return o
}
function invert(m: Mat4): Mat4 {
  // affine inverse (rotation + uniform-ish scale + translation), column-major
  const [a00, a01, a02, , a10, a11, a12, , a20, a21, a22, , tx, ty, tz] = m as [number, ...number[]] as number[]
  const b01 = a22! * a11! - a12! * a21!, b11 = -a22! * a10! + a12! * a20!, b21 = a21! * a10! - a11! * a20!
  const det = a00! * b01 + a01! * b11 + a02! * b21
  const id = 1 / det
  const r = [
    b01 * id, (-a22! * a01! + a02! * a21!) * id, (a12! * a01! - a02! * a11!) * id, 0,
    b11 * id, (a22! * a00! - a02! * a20!) * id, (-a12! * a00! + a02! * a10!) * id, 0,
    b21 * id, (-a21! * a00! + a01! * a20!) * id, (a11! * a00! - a01! * a10!) * id, 0,
    0, 0, 0, 1,
  ]
  r[12] = -(r[0]! * tx! + r[4]! * ty! + r[8]! * tz!)
  r[13] = -(r[1]! * tx! + r[5]! * ty! + r[9]! * tz!)
  r[14] = -(r[2]! * tx! + r[6]! * ty! + r[10]! * tz!)
  return r
}
const maxDiff = (a: Mat4, b: Mat4) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)))

function byName(doc: Document): Map<string, GNode> {
  return new Map(doc.getRoot().listNodes().map(n => [n.getName(), n]))
}

function depth(n: GNode): number {
  let d = 0
  for (let p = n.getParentNode(); p; p = p.getParentNode()) d++
  return d
}

function trisOf(node: GNode): number {
  const mesh = node.getMesh()
  if (!mesh) return 0
  return mesh.listPrimitives().reduce((a, p) => a + (p.getIndices()?.getCount() ?? 0) / 3, 0)
}

async function main(): Promise<void> {
  const io = new NodeIO()
  const doc = await io.read(IN)
  const retail = await io.read(RETAIL_GLB)
  const nodes = byName(doc)
  const rnodes = byName(retail)
  const skins = doc.getRoot().listSkins()
  if (skins.length !== 1) throw new Error(`expected one skin, found ${skins.length}`)
  const skin = skins[0]!
  const joints = skin.listJoints()
  const sidecar = JSON.parse(readFileSync(RETAIL_SIDE, 'utf8')) as Record<string, unknown>
  const retailJoints = (sidecar.skeleton as { joints: string[] }).joints

  // 1. every retail joint present, jiggle joints present
  const names = joints.map(j => j.getName())
  for (const n of [...retailJoints, ...JIGGLE]) if (!names.includes(n)) throw new Error(`joint ${n} missing from the export`)

  // 2. the retail joints keep the retail rest ORIENTATIONS exactly (the clips are local rotations) and the body's own
  //    joint POSITIONS (§15.2: its own bone lengths; the game drops the clips' non-root translations on a pilot body),
  //    the jiggle joints keep their world rest; then the inverse binds
  const jiggleWorld = new Map(JIGGLE.map(n => [n, nodes.get(n)!.getWorldMatrix() as Mat4]))
  const wantPos = new Map(retailJoints.map(n => [n, (nodes.get(n)!.getWorldMatrix() as Mat4).slice(12, 15)]))
  const rot = (m: Mat4) => [...m.slice(0, 3), ...m.slice(4, 7), ...m.slice(8, 11)]
  let worst = 0
  for (const n of retailJoints) worst = Math.max(worst, maxDiff(rot(nodes.get(n)!.getWorldMatrix() as Mat4), rot(rnodes.get(n)!.getWorldMatrix() as Mat4)))
  if (worst > 1e-3) throw new Error(`joint orientations differ from retail by ${worst}`)
  for (const n of [...retailJoints].sort((x, y) => depth(nodes.get(x)!) - depth(nodes.get(y)!))) {
    const a = nodes.get(n)!, b = rnodes.get(n)!
    a.setRotation(b.getRotation()).setScale(b.getScale())
    const pw = a.getParentNode()?.getWorldMatrix() as Mat4 | undefined
    const inv = pw ? invert(pw) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const w = wantPos.get(n)!
    a.setTranslation([0, 1, 2].map(i => inv[i]! * w[0]! + inv[4 + i]! * w[1]! + inv[8 + i]! * w[2]! + inv[12 + i]!) as [number, number, number])
  }
  // the skeleton root's ancestors (Blender's armature node) must be identity, as in retail
  for (let p = nodes.get('Bip01')!.getParentNode(); p; p = p.getParentNode()) {
    const id = maxDiff(p.getMatrix() as Mat4, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    if (id > 1e-6) throw new Error(`skeleton ancestor ${p.getName()} is not identity`)
  }
  for (const n of JIGGLE) {
    const j = nodes.get(n)!
    const parentW = j.getParentNode()!.getWorldMatrix() as Mat4
    const local = mul(invert(parentW), jiggleWorld.get(n)!)
    j.setMatrix(local as unknown as Parameters<GNode['setMatrix']>[0])
  }
  const ibm = skin.getInverseBindMatrices()!
  const arr = new Float32Array(joints.length * 16)
  joints.forEach((j, i) => arr.set(invert(j.getWorldMatrix() as Mat4), i * 16))
  ibm.setArray(arr)
  // the bind check: retail orientations exactly, the body's joint positions kept; bone lengths vs retail for the record
  const lengths: Record<string, number> = {}
  for (const n of retailJoints) {
    const m = nodes.get(n)!.getWorldMatrix() as Mat4
    const d = maxDiff(rot(m), rot(rnodes.get(n)!.getWorldMatrix() as Mat4))
    if (d > 1e-5) throw new Error(`joint ${n} orientation off the retail rest by ${d}`)
    if (maxDiff(m.slice(12, 15), wantPos.get(n)!) > 1e-5) throw new Error(`joint ${n} moved`)
    const L = Math.hypot(...nodes.get(n)!.getTranslation()), RL = Math.hypot(...rnodes.get(n)!.getTranslation())
    if (RL > 1e-3) lengths[n] = Math.round((L / RL) * 100) / 100
  }

  // the root translation scale (§15.3): the clips key the retail root height; the body's own hips sit lower or higher
  const rootY = (m: Mat4) => m[13]!
  const rootScale = Math.round((rootY(nodes.get('Bip01')!.getWorldMatrix() as Mat4) / rootY(rnodes.get('Bip01')!.getWorldMatrix() as Mat4)) * 1e4) / 1e4

  // the clip check (§15.3): what a pilot body plays of the retail packs: rotations and the root's translation, no scale
  const clipCheck = { channels: 0, kept: 0, scaleKept: 0, nonRootTranslationKept: 0, droppedTranslation: 0, droppedScale: 0 }
  for (const p of PACKS) {
    for (const a of (await (await gltfIO()).read(p)).getRoot().listAnimations()) {
      for (const c of a.listChannels()) {
        const path = c.getTargetPath() ?? ''
        const name = c.getTargetNode()?.getName()
        clipCheck.channels++
        if (!pilotTrackKept(path, name)) {
          if (path === 'scale') clipCheck.droppedScale++
          else clipCheck.droppedTranslation++
          continue
        }
        clipCheck.kept++
        if (path === 'scale') clipCheck.scaleKept++
        if (path === 'translation' && name !== 'Bip01') clipCheck.nonRootTranslationKept++
      }
    }
  }
  if (clipCheck.scaleKept || clipCheck.nonRootTranslationKept) throw new Error(`clip check: ${JSON.stringify(clipCheck)}`)

  // 3. materials
  for (const m of doc.getRoot().listMaterials()) {
    m.setEmissiveFactor([0, 0, 0]).setEmissiveTexture(null)
    if (/hair/i.test(m.getName())) m.setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true)
    else m.setAlphaMode('OPAQUE')
    if (/garment/i.test(m.getName())) m.setDoubleSided(true)
    // skin and the base cloth are not metal: the generated metal channel read as grey reflections on the face
    if (/body/i.test(m.getName())) m.setMetallicFactor(0)
  }

  // 4. textures: opaque maps to JPEG (sharp), keep PNG where alpha is used
  const sharp = (await import('sharp')).default
  const alphaTex = new Set(doc.getRoot().listMaterials().filter(m => m.getAlphaMode() !== 'OPAQUE').map(m => m.getBaseColorTexture()).filter(Boolean))
  for (const t of doc.getRoot().listTextures()) {
    const img = t.getImage()
    if (!img) continue
    const meta = await sharp(Buffer.from(img)).metadata()
    if ((meta.width ?? 0) > 1024) throw new Error(`texture ${t.getName()} is ${meta.width}² (budget 1024²)`)
    if (alphaTex.has(t)) continue
    t.setImage(new Uint8Array(await sharp(Buffer.from(img)).jpeg({ quality: 88 }).toBuffer())).setMimeType('image/jpeg')
  }

  // 5. budgets
  const stats: Record<string, number> = {}
  for (const n of doc.getRoot().listNodes()) if (n.getMesh()) stats[n.getName()] = trisOf(n)
  const sum = (re: RegExp) => Object.entries(stats).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0)
  const body = sum(/^pilot_body_/), head = sum(/^pilot_body_head$/), outfit = sum(/^pilot_outfit_a5$/)
  const hair = Math.max(sum(/^pilot_hair_ponytail$/), sum(/^pilot_hair_bob$/))
  const covered = Object.entries(stats).filter(([k]) => COVERS.a5!.some(r => k === `pilot_body_${r}`)).reduce((a, [, v]) => a + v, 0)
  const lod0 = { base: body + hair, a5: body - covered + outfit + hair }
  const problems: string[] = []
  if (body > BUDGET.body) problems.push(`body ${body} > ${BUDGET.body}`)
  if (head > BUDGET.head) problems.push(`head ${head} > ${BUDGET.head}`)
  if (outfit > BUDGET.outfit) problems.push(`outfit ${outfit} > ${BUDGET.outfit}`)
  if (hair > BUDGET.hair) problems.push(`hair ${hair} > ${BUDGET.hair}`)
  if (Math.max(lod0.base, lod0.a5) > BUDGET.total) problems.push(`LOD0 ${JSON.stringify(lod0)} > ${BUDGET.total}`)
  if (problems.length) throw new Error('budget: ' + problems.join(', '))
  const morphs = [...new Set(doc.getRoot().listMeshes().flatMap(m => (m.getExtras() as { targetNames?: string[] }).targetNames ?? []))]

  // 6. write
  const glb = await io.writeBinary(doc)
  const side = {
    ...Object.fromEntries(Object.entries(sidecar).filter(([k]) => !['meshes', 'materials', 'stats', 'validation', 'warnings', 'source'].includes(k))),
    name: 'female_pilot',
    generator: 'pilot-char.ts (P1 stage 1)',
    pilot: {
      version: 1,
      base: 'f',
      outfits: Object.fromEntries(Object.entries(COVERS).map(([k, v]) => [k, { covers: v }])),
      hair: Object.keys(stats).filter(k => k.startsWith('pilot_hair_')).map(k => k.slice('pilot_hair_'.length)),
      morphs,
      jiggle: JIGGLE,
      triangles: { ...stats, body, head, outfit, hair, lod0 },
      orientationErrorBefore: worst,
      rootScale,
      clipCheck,
      boneLengthVsRetail: lengths,
    },
  }
  for (const dir of OUTS) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'female_pilot.glb'), glb)
    writeFileSync(join(dir, 'female_pilot.json'), JSON.stringify(side, null, 1))
  }
  console.log(`female_pilot.glb ${(glb.byteLength / 1048576).toFixed(2)} MB; joints ${joints.length}; body ${body} (head ${head}), outfit ${outfit}, hair ${hair}; LOD0 ${JSON.stringify(lod0)}; morphs ${morphs.length}; retail orientations kept (error before ${worst.toExponential(2)}), own bone lengths; root scale ${rootScale}; clips ${JSON.stringify(clipCheck)}`)
}

await main()
