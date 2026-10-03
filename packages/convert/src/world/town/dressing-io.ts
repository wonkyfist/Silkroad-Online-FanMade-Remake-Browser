/**
 * The node side of the town dressing pass (./dressing.ts; lane TL-B): the export's nav (nav.bin's main walkable
 * component as the ground), the NPC and town-route keep-outs, our props (content/town/props/<name>.json + PNG, from
 * the Blender builder packages/convert/tools/blender/town/props/build.py) written as glb + sidecar, retail resources
 * converted from Data.pk2 the way the object step converts them (./objects.ts convertModel), and scaled copies.
 *
 * Reads nav.bin, never writes it: the dressing is decoration only (TOWN_LIFE §12.2 TL-B).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Document, NodeIO, type Material, type Texture } from '@gltf-transform/core'
import { decodeNavData, NavWorld } from '@sro/nav'
import { validateTownFile } from '../../../../shared/src/town.ts'
import type { Sidecar, SidecarMaterial, SidecarMesh } from '../../gltf/convert.ts'
import { validateGlb } from '../../gltf/validate.ts'
import { openArchive, REPO_ROOT } from '../../node-io.ts'
import type { WorldModel } from '../manifest.ts'
import { NAV_FILE } from '../nav.ts'
import { convertModel, ddjToPng, normKey, outputStem } from '../objects.ts'
import type { WorldPassContext } from '../passes.ts'
import { propCloth, type DressingDeps, type DressingGround, type DressingModelRequest, type TownPropMesh } from './dressing.ts'

/** Where our props live (the Blender builder's output and the painted PNGs). */
export const TOWN_PROPS_DIR = join(REPO_ROOT, 'content', 'town', 'props')
/** Jangan object BMTs' diffuse = ambient (150/255), so our props light like the retail ones on the Classic path. */
const PROP_DIFFUSE = 150 / 255

type Vec3 = [number, number, number]

/** The ground of an export: nav.bin's largest walkable component, highest surface (the plaza's floor over the terrain). */
export function navGround(nav: NavWorld, origin: { x: number; z: number }): DressingGround {
  const main = nav.components()[0]
  if (!main) return () => null
  return (x, z) => {
    const p = nav.locateIn(origin.x * 1920 + x * 10, origin.z * 1920 - z * 10, Infinity, main.id)
    return p ? p.y / 10 : null
  }
}

/** Checks the shape of a prop mesh JSON (the builder's format). */
export function validPropMesh(json: unknown): json is TownPropMesh {
  const j = json as Partial<TownPropMesh> | null
  if (!j || j.format !== 'sro-town-prop' || j.version !== 1 || !Array.isArray(j.materials) || !Array.isArray(j.primitives)) return false
  return j.primitives.every(p => p && Number.isInteger(p.material) && p.material >= 0 && p.material < j.materials!.length &&
    p.positions.length % 3 === 0 && p.normals.length === p.positions.length && p.uvs.length / 2 === p.positions.length / 3 &&
    p.indices.length % 3 === 0 && p.indices.every(i => Number.isInteger(i) && i >= 0 && i < p.positions.length / 3))
}

/** A prop mesh as a glb (one root node named after the prop, one mesh per material, like the converted retail glbs). */
export async function propGlb(mesh: TownPropMesh, scale: number, readPng: (file: string) => Uint8Array): Promise<{ glb: Uint8Array; sidecar: Sidecar; boundsMin: Vec3; boundsMax: Vec3 }> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const root = doc.createNode(mesh.name)
  doc.createScene(mesh.name).addChild(root)
  const textures = new Map<string, Texture>()
  const tex = (file: string) => {
    let t = textures.get(file)
    if (!t) textures.set(file, (t = doc.createTexture(file.replace(/\.png$/i, '')).setImage(readPng(file)).setMimeType('image/png')))
    return t
  }
  const mats: Material[] = mesh.materials.map(m => {
    const mat = doc.createMaterial(m.name).setMetallicFactor(0).setAlphaMode(m.alphaMode).setDoubleSided(m.doubleSided).setBaseColorTexture(tex(m.texture))
    if (m.alphaMode === 'MASK') mat.setAlphaCutoff(m.alphaCutoff ?? 0.5)
    mat.getBaseColorTextureInfo()!.setMagFilter(9729).setMinFilter(9987)
    return mat
  })
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  const meshes: SidecarMesh[] = []
  let vertices = 0
  let triangles = 0
  mesh.primitives.forEach((p, k) => {
    const name = mesh.primitives.length === mesh.materials.length ? mesh.materials[p.material]!.name : `${mesh.materials[p.material]!.name}_${k}`
    const pos = new Float32Array(p.positions.map(v => v * scale))
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], pos[i + a]!)
      hi[a] = Math.max(hi[a], pos[i + a]!)
    }
    const n = pos.length / 3
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p.normals)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(p.uvs)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(n > 65535 ? new Uint32Array(p.indices) : new Uint16Array(p.indices)).setBuffer(buffer))
      .setMaterial(mats[p.material]!)
    root.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)))
    meshes.push({ name, bms: '', material: mesh.materials[p.material]!.name, vertices: n, triangles: p.indices.length / 3, skinned: false, bones: [] })
    vertices += n
    triangles += p.indices.length / 3
  })
  const glb = await new NodeIO().writeBinary(doc)
  const round = (v: Vec3): Vec3 => v.map(x => Number(x.toFixed(5)) + 0) as Vec3
  const materials: SidecarMaterial[] = mesh.materials.map(m => ({
    name: m.name,
    bmt: '',
    flags: 0,
    flagNames: [],
    texture: `town/props/${m.texture}`,
    alphaMode: m.alphaMode,
    ...(m.alphaMode === 'MASK' ? { alphaCutoff: m.alphaCutoff ?? 0.5 } : {}),
    alphaReason: 'town prop (content/town/props)',
    doubleSided: m.doubleSided,
    diffuse: [PROP_DIFFUSE, PROP_DIFFUSE, PROP_DIFFUSE, 1],
    ambient: [PROP_DIFFUSE, PROP_DIFFUSE, PROP_DIFFUSE, 1],
    specular: [0, 0, 0, 1],
    emissive: [0, 0, 0, 1],
    power: 0,
  }))
  const sidecar: Sidecar = {
    source: `town/props/${mesh.name}`,
    version: 'sro-town-prop 1',
    generator: 'packages/convert/src/world/town/dressing-io.ts (from packages/convert/tools/blender/town/props/build.py)',
    name: mesh.name,
    type: 'town prop',
    units: { metresPerUnit: 1, sourceUnit: 'metre', handedness: 'right-handed', up: '+Y', forward: '+Z' },
    skeleton: null,
    attachBone: null,
    attachable: null,
    materials,
    meshes,
    animations: [],
    stats: { vertices, triangles, joints: 0, meshes: meshes.length, animations: 0, textures: textures.size, heightM: Number((hi[1] - lo[1]).toFixed(5)), boundsMin: round(lo), boundsMax: round(hi) },
    warnings: [],
  }
  return { glb, sidecar, boundsMin: round(lo), boundsMax: round(hi) }
}

/** A converted glb scaled about its origin (each scene root's translation and scale × s); the sidecar's bounds too. */
export async function scaledGlb(glb: Uint8Array, sidecar: Sidecar, s: number): Promise<{ glb: Uint8Array; sidecar: Sidecar }> {
  const io = new NodeIO()
  const doc = await io.readBinary(glb)
  for (const scene of doc.getRoot().listScenes()) {
    for (const n of scene.listChildren()) {
      const t = n.getTranslation()
      const k = n.getScale()
      n.setTranslation([t[0] * s, t[1] * s, t[2] * s]).setScale([k[0] * s, k[1] * s, k[2] * s])
    }
  }
  const out = await io.writeBinary(doc)
  const sc = (v: Vec3): Vec3 => v.map(x => Number((x * s).toFixed(5)) + 0) as Vec3
  const st = sidecar.stats
  return { glb: out, sidecar: { ...sidecar, stats: { ...st, heightM: Number((st.heightM * s).toFixed(5)), boundsMin: sc(st.boundsMin), boundsMax: sc(st.boundsMax) } } }
}

function writeOut(outDir: string, rel: string, bytes: Uint8Array | string): number {
  const file = join(outDir, ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  return typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

/** The node deps of the dressing pass (`propsDir` default content/town/props). */
export function nodeDressingDeps(opts: { propsDir?: string; validate?: boolean } = {}): DressingDeps {
  const propsDir = opts.propsDir ?? TOWN_PROPS_DIR
  const validate = opts.validate !== false
  return {
    ground(ctx: WorldPassContext): DressingGround | null {
      const file = join(ctx.outDir, NAV_FILE)
      if (!existsSync(file)) return null
      return navGround(new NavWorld(decodeNavData(new Uint8Array(readFileSync(file)))), ctx.origin)
    },

    npcs(ctx: WorldPassContext): Array<{ x: number; z: number }> {
      const file = resolve(ctx.outDir, '..', '..', 'data', 'npcs.json')
      if (!existsSync(file)) return []
      try {
        const j = readJson(file) as { entries?: Array<{ x?: unknown; z?: unknown }> }
        return (j.entries ?? []).filter(e => typeof e.x === 'number' && typeof e.z === 'number').map(e => ({ x: e.x as number, z: e.z as number }))
      } catch (e) {
        ctx.warnings.push(`town dressing: ${file}: ${(e as Error).message}; no NPC keep-out`)
        return []
      }
    },

    routes(ctx: WorldPassContext): Array<[number, number, number, number]> {
      const file = join(ctx.outDir, 'town.json')
      if (!existsSync(file)) return []
      try {
        const res = validateTownFile(readJson(file))
        if (!res.ok || res.file.kind !== 'town') return []
        const at = new Map(res.file.graph.nodes.map(n => [n.id, n]))
        const out: Array<[number, number, number, number]> = []
        for (const e of res.file.graph.edges) {
          const a = at.get(e.a)
          const b = at.get(e.b)
          if (a && b) out.push([a.x, a.z, b.x, b.z])
        }
        return out
      } catch {
        return []
      }
    },

    prop(name: string, warnings: string[]): TownPropMesh | null {
      const file = join(propsDir, `${name}.json`)
      try {
        const j = readJson(file)
        if (!validPropMesh(j)) {
          warnings.push(`town dressing: ${file}: not a town prop mesh`)
          return null
        }
        return j
      } catch (e) {
        warnings.push(`town dressing: prop ${name}: ${(e as Error).message}`)
        return null
      }
    },

    async writeModel(req: DressingModelRequest, ctx: WorldPassContext, base: WorldModel | null) {
      const glbRel = `models/${req.stem}.glb`
      const sidecarRel = `models/${req.stem}.json`
      const done = async (glb: Uint8Array, sidecar: Sidecar, source: string, extra: Partial<WorldModel> = {}): Promise<Omit<WorldModel, 'index' | 'staticVariant'>> => {
        let validatorErrors: number | null = null
        if (validate) {
          const v = await validateGlb(glb, `${req.stem}.glb`)
          validatorErrors = v.errors
          if (v.errors) ctx.warnings.push(`town dressing: ${glbRel}: ${v.errors} glTF validator error(s)`)
        }
        const bytes = writeOut(ctx.outDir, glbRel, glb)
        writeOut(ctx.outDir, sidecarRel, JSON.stringify(sidecar, null, 2) + '\n')
        const s = sidecar.stats
        return {
          source,
          glb: glbRel,
          sidecar: sidecarRel,
          kind: s.joints > 0 ? 'skinned' : 'static',
          animations: sidecar.animations.map(a => a.name),
          defaultClip: base?.defaultClip ?? (sidecar.animations[0]?.name ?? null),
          lightmappedMeshes: sidecar.meshes.filter(m => m.lightmap).length,
          boundsMin: s.boundsMin,
          boundsMax: s.boundsMax,
          bytes,
          validatorErrors,
          ...extra,
        }
      }
      try {
        if (req.from === 'prop') {
          const file = join(propsDir, `${req.ref}.json`)
          const mesh = readJson(file)
          if (!validPropMesh(mesh)) throw new Error(`${file}: not a town prop mesh`)
          const out = await propGlb(mesh, req.scale, png => new Uint8Array(readFileSync(join(propsDir, png))))
          const cloth = propCloth(mesh, req.scale, req.cloth)
          return await done(out.glb, out.sidecar, `town/props/${mesh.name}`, cloth.length ? { cloth } : {})
        }
        if (req.from === 'export') {
          if (!base?.glb || !base.sidecar) throw new Error(`model ${req.ref} has no glb`)
          const glb = new Uint8Array(readFileSync(join(ctx.outDir, ...base.glb.split('/'))))
          const side = readJson(join(ctx.outDir, ...base.sidecar.split('/'))) as Sidecar
          const out = await scaledGlb(glb, side, req.scale)
          return await done(out.glb, out.sidecar, base.source)
        }
        // retail: convert from Data.pk2 like the object step, then scale when asked
        const data = openArchive('Data')
        const source = req.ref.trim().replace(/\//g, '\\')
        if (!data.has(source)) throw new Error(`${req.ref}: not in Data.pk2`)
        const lightmaps = new Map<string, string>()
        const conv = await convertModel(0, { source, stem: outputStem(source) }, data, ctx.outDir, lightmaps, validate)
        if (conv.model.kind === 'failed' || !conv.sidecar) throw new Error(conv.model.error ?? 'conversion failed')
        for (const [key, uri] of lightmaps) {
          if (existsSync(join(ctx.outDir, ...uri.split('/')))) continue
          try {
            ddjToPng(data.read(key), ctx.outDir, uri)
          } catch (e) {
            ctx.warnings.push(`town dressing: lightmap ${normKey(key)}: ${(e as Error).message}`)
          }
        }
        if (req.scale === 1 && req.stem === outputStem(source)) {
          const { index: _i, ...m } = conv.model
          return m
        }
        const glb = new Uint8Array(readFileSync(join(ctx.outDir, ...conv.model.glb!.split('/'))))
        const out = await scaledGlb(glb, conv.sidecar, req.scale)
        return await done(out.glb, out.sidecar, source)
      } catch (e) {
        ctx.warnings.push(`town dressing: model ${req.ref}: ${(e as Error).message}`)
        return null
      }
    },

    writeJson(ctx: WorldPassContext, rel: string, value: unknown): void {
      writeOut(ctx.outDir, rel, JSON.stringify(value, null, 1) + '\n')
    },
  }
}
