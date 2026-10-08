/**
 * Pack checks that need the Node glTF stack (run after pack.py build):
 *  - Khronos glTF-Validator on every pack glb (errors must be 0).
 *  - The slimmed game glb (/out-opt/, meshopt + KHR_mesh_quantization) carries the same UVs as the pack glb,
 *    within quantization error, so a texture baked on the pack UVs lands the same in the slimmed game assets.
 * Writes manifest.verify.optUv and manifest.verify.validator. Reads only local files; no network.
 *
 *   pnpm exec tsx work/remaster/tools/meshy/verify-opt.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..')
const PACK = join(REPO, 'work', 'remaster', 'pack')
const OUT_OPT = join(REPO, 'work', 'out-opt')
const convertRequire = createRequire(join(REPO, 'packages', 'convert', 'package.json'))
const { gltfIO } = await import(pathToFileURL(join(REPO, 'packages', 'convert', 'src', 'optimize', 'io.ts')).href)
const validator = convertRequire('gltf-validator')

type Doc = Awaited<ReturnType<Awaited<ReturnType<typeof gltfIO>>['read']>>

/** Mesh-space positions (x node world matrix when `world`: the slimmed glbs keep the position dequantization
 * scale/offset on the mesh node) and UVs (dequantized by getElement). */
function meshData(doc: Doc, name: string, world: boolean): { pos: number[][], uv: number[][] } {
  const mesh = doc.getRoot().listMeshes().find((m) => m.getName() === name)
  if (!mesh) throw new Error(`mesh ${name} missing`)
  const prim = mesh.listPrimitives()[0]
  const node = doc.getRoot().listNodes().find((n) => n.getMesh() === mesh)
  const m = world && node ? node.getWorldMatrix() : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const read = (sem: string): number[][] => {
    const acc = prim.getAttribute(sem)
    if (!acc) throw new Error(`${name}: no ${sem}`)
    const out: number[][] = []
    for (let i = 0; i < acc.getCount(); i++) out.push(acc.getElement(i, []))
    return out
  }
  const pos = read('POSITION').map(([x, y, z]) => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ])
  return { pos, uv: read('TEXCOORD_0') }
}

const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'))
const io = await gltfIO()
const optUv: unknown[] = []
const validatorResults: unknown[] = []
let ok = true

for (const part of manifest.parts) {
  const packPath = join(REPO, part.glb)
  const bytes = new Uint8Array(readFileSync(packPath))
  const report = await validator.validateBytes(bytes, { maxIssues: 50 })
  const { numErrors, numWarnings } = report.issues
  validatorResults.push({ id: part.id, errors: numErrors, warnings: numWarnings,
    messages: report.issues.messages.filter((m: { severity: number }) => m.severity <= 1)
      .map((m: { code: string, pointer?: string }) => `${m.code} ${m.pointer ?? ''}`.trim()) })
  if (numErrors > 0) ok = false

  const pack = await io.read(packPath)
  // A part may pack meshes from several game glbs (manifest meshes[].source.file, e.g. blade_01/02/03).
  const opts = new Map<string, Doc>()
  const optOf = async (rel: string): Promise<Doc> => {
    if (!opts.has(rel)) opts.set(rel, await io.read(join(OUT_OPT, ...rel.split('/'))))
    return opts.get(rel)!
  }
  const optRels = new Set<string>()
  let maxUvErr = 0
  let sameOrder = true
  let vertices = 0
  for (const m of part.meshes) {
    const optRel = m.source?.file ? m.source.file.replace(/^work\/out\//, '') : part.game.glbOpt.replace(/^\/out-opt\//, '')
    optRels.add(optRel)
    const opt = await optOf(optRel)
    const a = meshData(pack, m.name, false)
    const b = meshData(opt, m.name, true)
    vertices += a.uv.length
    if (a.uv.length !== b.uv.length) sameOrder = false
    // Match every slimmed vertex to the pack vertex with the nearest position+UV (the optimizer may reorder).
    for (let i = 0; i < b.uv.length; i++) {
      let best = Infinity
      let bestUv = Infinity
      const tryIndex = (j: number): void => {
        const dp = Math.hypot(a.pos[j][0] - b.pos[i][0], a.pos[j][1] - b.pos[i][1], a.pos[j][2] - b.pos[i][2])
        const du = Math.max(Math.abs(a.uv[j][0] - b.uv[i][0]), Math.abs(a.uv[j][1] - b.uv[i][1]))
        if (dp + du < best) { best = dp + du; bestUv = du }
      }
      if (sameOrder && i < a.uv.length) tryIndex(i)
      if (!(best < 1e-2)) {
        sameOrder = false
        for (let j = 0; j < a.uv.length; j++) tryIndex(j)
      }
      maxUvErr = Math.max(maxUvErr, bestUv)
    }
  }
  // 12-16 bit UV quantization: expect errors well under one texel of a 1k texture (1/1024 ~ 0.001).
  const good = maxUvErr < 1 / 1024
  if (!good) ok = false
  optUv.push({ id: part.id, optGlb: [...optRels].map((r) => '/out-opt/' + r).join(', '), vertices, sameVertexOrder: sameOrder,
    maxUvError: maxUvErr, maxUvErrorTexels: maxUvErr * Math.max(...part.game.material.textureSize),
    withinOneTexelAt1k: good })
  console.log(good && numErrors === 0 ? 'OK  ' : 'FAIL', part.id, `validator ${numErrors}E/${numWarnings}W`,
    `opt max uv err ${maxUvErr.toExponential(2)} sameOrder=${sameOrder}`)
}

manifest.verify = { ...(manifest.verify ?? {}), optUv, validator: validatorResults }
writeFileSync(join(PACK, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
process.exit(ok ? 0 : 1)
