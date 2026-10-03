/**
 * TP-P: the UV triangles of a texture (docs/TEXPIPE.md §3.2 "UV islands"), read on the main thread (Node only) from
 * every glb that uses it: the world models of the manifest and the actor sidecars under char/, npc/, mob/,
 * equipment/, item/. A texture shared by several glbs (the Copper Sword atlas `sword1_2_3` serves sword_01..03 and
 * the drop item) gets the union of their islands, so no user's UVs fall in a gutter.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WorldManifest } from '../../../convert/src/world/manifest.ts'
import { keyOf } from '../format.ts'
import { ACTOR_GROUPS, parseGlb, readAccessor } from '../inventory.ts'

export interface UvSource {
  /** Absolute glb path. */
  glb: string
  /** Lower-case glTF material names whose primitives use the texture. */
  materials: string[]
}

interface SidecarLite {
  materials?: Array<{ name?: string; texture?: string | null }>
}

/** For each wanted key, the glbs and material names that use it (world models first, then actor sidecars). */
export function findUvSources(outDir: string, world: string, keys: ReadonlySet<string>): Map<string, UvSource[]> {
  const out = new Map<string, Map<string, Set<string>>>()
  const add = (key: string, glb: string, material: string) => {
    let byGlb = out.get(key)
    if (!byGlb) out.set(key, (byGlb = new Map()))
    let names = byGlb.get(glb)
    if (!names) byGlb.set(glb, (names = new Set()))
    names.add(material.toLowerCase())
  }
  const scan = (sidecar: string, glb: string) => {
    let sc: SidecarLite
    try {
      const text = readFileSync(sidecar, 'utf8')
      sc = JSON.parse(text) as SidecarLite
    } catch {
      return
    }
    for (const m of sc.materials ?? []) {
      if (!m.texture || !m.name) continue
      const key = keyOf(m.texture)
      if (keys.has(key)) add(key, glb, m.name)
    }
  }
  const worldDir = join(outDir, 'world', world)
  const manifestPath = join(worldDir, 'manifest.json')
  if (existsSync(manifestPath)) {
    const man = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorldManifest
    for (const m of man.models) if (m.sidecar && m.glb) scan(join(worldDir, m.sidecar), join(worldDir, m.glb))
  }
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!ent.name.includes('_anims')) walk(p)
      } else if (ent.name.endsWith('.json') && !ent.name.endsWith('index.json') && ent.name !== 'equipment.json') {
        const glb = p.replace(/\.json$/, '.glb')
        if (existsSync(glb)) scan(p, glb)
      }
    }
  }
  for (const g of ACTOR_GROUPS) walk(join(outDir, g))
  const result = new Map<string, UvSource[]>()
  for (const [key, byGlb] of out) result.set(key, [...byGlb].map(([glb, names]) => ({ glb, materials: [...names] })))
  return result
}

/**
 * The UV triangles (u0 v0 u1 v1 u2 v2 …) of the primitives of these glbs whose material name is listed; with `mesh`,
 * only the meshes whose name matches it (DT-2's face pass: the `*_face` mesh of a body glb).
 */
export function uvTriangles(sources: readonly UvSource[], mesh?: RegExp): Float64Array {
  const out: number[] = []
  for (const s of sources) {
    if (!existsSync(s.glb)) continue
    const glb = parseGlb(readFileSync(s.glb))
    const names = new Set(s.materials.map(m => m.toLowerCase()))
    for (const m of glb.json.meshes ?? []) {
      if (mesh && !mesh.test(m.name ?? '')) continue
      for (const pr of m.primitives) {
        if (pr.material === undefined || (pr.mode !== undefined && pr.mode !== 4)) continue
        const name = glb.json.materials?.[pr.material]?.name?.toLowerCase()
        if (name === undefined || !names.has(name) || pr.attributes.TEXCOORD_0 === undefined) continue
        const uv = readAccessor(glb, pr.attributes.TEXCOORD_0)
        const idx = pr.indices !== undefined ? readAccessor(glb, pr.indices).data : Float64Array.from({ length: uv.count }, (_, i) => i)
        for (let t = 0; t + 2 < idx.length; t += 3) {
          for (let k = 0; k < 3; k++) {
            const v = idx[t + k]!
            out.push(uv.data[v * 2]!, uv.data[v * 2 + 1]!)
          }
        }
      }
    }
  }
  return Float64Array.from(out)
}
