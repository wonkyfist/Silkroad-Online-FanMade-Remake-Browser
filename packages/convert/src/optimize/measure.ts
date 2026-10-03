/**
 * Size census of a converter output tree (work/out or work/out-opt): bytes per category and file type,
 * a per-glb split into textures / animation / geometry, and animation-clip duplication statistics
 * (within one character and across characters that share a skeleton).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { extname, join, relative } from 'node:path'
import type { Animation, Document } from '@gltf-transform/core'
import { bytesOf, gltfIO, sha1 } from './io.ts'

export function walkFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkFiles(root, p, out)
    else if (e.isFile()) out.push(relative(root, p).replace(/\\/g, '/'))
  }
  return out.sort()
}

/** 'world/jangan/models/bldg/x.glb' -> 'world/jangan/models'; 'char/china/a.glb' -> 'char'. */
export function categoryOfPath(rel: string): string {
  const parts = rel.split('/')
  if (parts[0] === 'world' && parts.length > 3) return parts.slice(0, 3).join('/')
  if (parts[0] === 'world' && parts.length === 3) return `${parts[0]}/${parts[1]}/(root)`
  return parts.length > 1 ? parts[0]! : '(root)'
}

export interface GlbBreakdown {
  total: number
  textures: number
  animation: number
  geometry: number
  clips: number
  uniqueClips: number
}

/** Stable content hash of a clip: channels by target node name + path, sampler interpolation and raw key bytes. */
export function clipHash(anim: Animation): string {
  const parts: string[] = []
  const blobs: Uint8Array[] = []
  const channels = anim.listChannels().map(c => ({
    key: `${c.getTargetNode()?.getName() ?? '?'}|${c.getTargetPath()}`,
    s: c.getSampler()!,
  })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const { key, s } of channels) {
    parts.push(`${key}|${s.getInterpolation()}`)
    blobs.push(bytesOf(s.getInput()!.getArray()!), bytesOf(s.getOutput()!.getArray()!))
  }
  return sha1(parts.join(';'), ...blobs)
}

export function breakdown(doc: Document, total: number): GlbBreakdown {
  const root = doc.getRoot()
  let textures = 0
  for (const t of root.listTextures()) textures += t.getImage()?.byteLength ?? 0
  const animAcc = new Set<object>()
  let animation = 0
  for (const a of root.listAnimations()) {
    for (const s of a.listSamplers()) {
      for (const acc of [s.getInput(), s.getOutput()]) {
        if (acc && !animAcc.has(acc)) {
          animAcc.add(acc)
          animation += acc.getArray()?.byteLength ?? 0
        }
      }
    }
  }
  let geometry = 0
  for (const acc of root.listAccessors()) if (!animAcc.has(acc)) geometry += acc.getArray()?.byteLength ?? 0
  const hashes = new Set(root.listAnimations().map(clipHash))
  return { total, textures, animation, geometry, clips: root.listAnimations().length, uniqueClips: hashes.size }
}

export interface Census {
  root: string
  totalBytes: number
  byCategory: Record<string, { files: number; bytes: number; wire: number; byExt: Record<string, number> }>
  /** Bytes on the wire with gzip level 6 applied to compressible types (glb, json, bin, js); images/audio as is. */
  wireBytes: number
  glb: Record<string, { files: number; total: number; textures: number; animation: number; geometry: number }>
  characters?: CharacterClipStats
}

export interface CharacterClipStats {
  characters: number
  clips: number
  uniqueWithinCharacter: number
  uniqueAcrossAll: number
  /** Skeleton key (hash of joint names) -> characters and unique clips among them. */
  skeletons: { key: string; characters: string[]; clips: number; unique: number }[]
}

export const COMPRESSIBLE = new Set(['.glb', '.json', '.bin', '.js', '.gltf', '.txt', '.ttf'])

export function wireSize(bytes: Uint8Array, ext: string): number {
  return COMPRESSIBLE.has(ext) ? gzipSync(bytes, { level: 6 }).byteLength : bytes.byteLength
}

export async function census(root: string, opts: { glbDetail?: boolean; wire?: boolean; filter?: (rel: string) => boolean } = {}): Promise<Census> {
  const files = walkFiles(root).filter(f => !f.endsWith('.br') && (opts.filter?.(f) ?? true))
  const byCategory: Census['byCategory'] = {}
  const glb: Census['glb'] = {}
  let totalBytes = 0
  let wireBytes = 0
  const io = opts.glbDetail ? await gltfIO() : null
  const charClips = new Map<string, { skel: string; hashes: string[] }>()
  for (const rel of files) {
    const size = statSync(join(root, rel)).size
    totalBytes += size
    const cat = categoryOfPath(rel)
    const c = (byCategory[cat] ??= { files: 0, bytes: 0, wire: 0, byExt: {} })
    c.files++
    c.bytes += size
    const ext = extname(rel).toLowerCase() || '(none)'
    const wire = opts.wire ? wireSize(readFileSync(join(root, rel)), ext) : size
    c.wire += wire
    wireBytes += wire
    c.byExt[ext] = (c.byExt[ext] ?? 0) + size
    if (io && ext === '.glb') {
      const doc = await io.readBinary(readFileSync(join(root, rel)))
      const b = breakdown(doc, size)
      const g = (glb[cat] ??= { files: 0, total: 0, textures: 0, animation: 0, geometry: 0 })
      g.files++
      g.total += size
      g.textures += b.textures
      g.animation += b.animation
      g.geometry += b.geometry
      if (cat === 'char' && b.clips > 0) {
        const joints = doc.getRoot().listSkins()[0]?.listJoints().map(j => j.getName()) ?? []
        charClips.set(rel, { skel: sha1(joints.join('|')).slice(0, 12), hashes: doc.getRoot().listAnimations().map(clipHash) })
      }
    }
  }
  const out: Census = { root, totalBytes, wireBytes, byCategory, glb }
  if (charClips.size) {
    let clips = 0
    let within = 0
    const all = new Set<string>()
    const bySkel = new Map<string, { characters: string[]; clips: number; set: Set<string> }>()
    for (const [rel, { skel, hashes }] of charClips) {
      clips += hashes.length
      within += new Set(hashes).size
      const s = bySkel.get(skel) ?? { characters: [], clips: 0, set: new Set<string>() }
      bySkel.set(skel, s)
      s.characters.push(rel)
      s.clips += hashes.length
      for (const h of hashes) {
        all.add(h)
        s.set.add(h)
      }
    }
    out.characters = {
      characters: charClips.size,
      clips,
      uniqueWithinCharacter: within,
      uniqueAcrossAll: all.size,
      skeletons: [...bySkel].map(([key, s]) => ({ key, characters: s.characters, clips: s.clips, unique: s.set.size })),
    }
  }
  return out
}
