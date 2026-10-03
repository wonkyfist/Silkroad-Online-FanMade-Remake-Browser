/**
 * Animation packs: characters lose their embedded clips; every distinct clip (by content hash) is written once per
 * skeleton into an animation-only glb ("pack") whose nodes are the skeleton joints (same names, same rest TRS)
 * and whose animations target those joints. A runtime retargets a pack clip onto a loaded character by joint name.
 *
 * Pack assignment per skeleton: a clip that any character uses in its 'default' aniGroup lives in `default.glb`;
 * any other clip lives in the pack of each group that uses it (the few clips shared by two weapon groups are
 * stored in both), so "default + one weapon pack" always covers a weapon stance.
 */
import { Document, type Animation, type AnimationSampler, type Node } from '@gltf-transform/core'
import { EXTMeshoptCompression } from '@gltf-transform/extensions'
import { dedup, prune } from '@gltf-transform/functions'
import { clipHash } from './measure.ts'
import { bytesOf, sha1 } from './io.ts'

export const PACK_DIR = 'char/_anims'

export interface SidecarAnimation {
  name: string
  group: string
  banName?: string
  partial?: boolean
}

export interface CharacterSource {
  /** Relative glb path, e.g. 'char/china/chinaman_adventurer.glb'. */
  rel: string
  doc: Document
  animations: SidecarAnimation[]
  /** Sidecar skeleton.bsk (Data path), used to name the pack folder. */
  bsk?: string
}

/** Added to the optimized sidecar as `animationPacks`. */
export interface AnimationPackIndex {
  format: 'sro-anim-packs'
  version: 1
  /** Pack folder name, e.g. 'europeman_skel'. */
  skeleton: string
  /** Group -> pack glb path relative to the out root (only the groups this character uses). */
  packs: Record<string, string>
  /** Character clip name (as in the original glb and sidecar) -> [group whose pack holds it, animation name in the pack]. */
  clips: Record<string, [string, string]>
}

export interface PackBuild {
  /** Out-root-relative pack path -> document. */
  packs: Map<string, Document>
  index: Map<string, AnimationPackIndex>
  stats: { characters: number; clips: number; uniqueClips: number; packClips: number; skeletons: Record<string, { characters: number; unique: number; packs: Record<string, number> }> }
}

export function skeletonKey(doc: Document): string {
  const skin = doc.getRoot().listSkins()[0]
  if (!skin) throw new Error('no skin')
  const parts: (string | Uint8Array)[] = []
  for (const j of skin.listJoints()) {
    parts.push(`${j.getName()}<${j.getParentNode()?.getName() ?? ''}`)
    parts.push(bytesOf(new Float64Array([...j.getTranslation(), ...j.getRotation(), ...j.getScale()])))
  }
  return sha1(...parts).slice(0, 12)
}

function baseName(p: string): string {
  return (p.replace(/\\/g, '/').split('/').pop() ?? p).replace(/\.[^.]*$/, '').toLowerCase()
}

interface ClipEntry {
  hash: string
  anim: Animation
  label: string
  groups: Set<string>
}

export function buildPacks(chars: CharacterSource[], packDir = PACK_DIR): PackBuild {
  const bySkel = new Map<string, { chars: CharacterSource[]; names: Set<string> }>()
  for (const c of chars) {
    const key = skeletonKey(c.doc)
    const e = bySkel.get(key) ?? { chars: [], names: new Set<string>() }
    e.chars.push(c)
    if (c.bsk) e.names.add(baseName(c.bsk))
    bySkel.set(key, e)
  }
  const usedNames = new Set<string>()
  const packs = new Map<string, Document>()
  const index = new Map<string, AnimationPackIndex>()
  const stats: PackBuild['stats'] = { characters: chars.length, clips: 0, uniqueClips: 0, packClips: 0, skeletons: {} }
  for (const [key, { chars: members, names }] of [...bySkel].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let skelName = [...names].sort()[0] ?? `skel_${key}`
    if (usedNames.has(skelName)) skelName = `${skelName}_${key.slice(0, 6)}`
    usedNames.add(skelName)
    members.sort((a, b) => (a.rel < b.rel ? -1 : 1))
    const clips = new Map<string, ClipEntry>()
    const perChar = new Map<CharacterSource, { name: string; hash: string; group: string }[]>()
    for (const c of members) {
      const side = new Map(c.animations.map(a => [a.name, a]))
      const list: { name: string; hash: string; group: string }[] = []
      for (const anim of c.doc.getRoot().listAnimations()) {
        const s = side.get(anim.getName())
        const group = s?.group ?? 'default'
        const hash = clipHash(anim)
        const e = clips.get(hash) ?? { hash, anim, label: s?.banName ?? anim.getName(), groups: new Set<string>() }
        e.groups.add(group)
        clips.set(hash, e)
        list.push({ name: anim.getName(), hash, group })
        stats.clips++
      }
      perChar.set(c, list)
    }
    // Pack membership and unique, readable names inside each pack.
    const packOf = (e: ClipEntry): string[] => (e.groups.has('default') ? ['default'] : [...e.groups].sort())
    const nameIn = new Map<string, Map<string, string>>()
    for (const e of [...clips.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.hash < b.hash ? -1 : 1))) {
      for (const g of packOf(e)) {
        const m = nameIn.get(g) ?? new Map<string, string>()
        nameIn.set(g, m)
        const taken = new Set(m.values())
        m.set(e.hash, taken.has(e.label) ? `${e.label}~${e.hash.slice(0, 6)}` : e.label)
      }
    }
    const skelStats = { characters: members.length, unique: clips.size, packs: {} as Record<string, number> }
    stats.uniqueClips += clips.size
    const template = members[0]!.doc
    for (const [group, names] of [...nameIn].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const rel = `${packDir}/${skelName}/${group}.glb`
      const doc = createPackDocument(template, `${skelName}/${group}`)
      for (const [hash, animName] of [...names].sort((a, b) => (a[1] < b[1] ? -1 : 1))) copyAnimation(clips.get(hash)!.anim, doc, animName)
      packs.set(rel, doc)
      skelStats.packs[group] = names.size
      stats.packClips += names.size
    }
    stats.skeletons[skelName] = skelStats
    for (const c of members) {
      const idx: AnimationPackIndex = { format: 'sro-anim-packs', version: 1, skeleton: skelName, packs: {}, clips: {} }
      for (const { name, hash, group } of perChar.get(c)!) {
        const e = clips.get(hash)!
        const g = e.groups.has('default') ? 'default' : group
        idx.clips[name] = [g, nameIn.get(g)!.get(hash)!]
        idx.packs[g] = `${packDir}/${skelName}/${g}.glb`
      }
      index.set(c.rel, idx)
    }
  }
  return { packs, index, stats }
}

/**
 * A document holding only the skeleton joints (names, hierarchy, rest TRS) of `template`'s first skin. Also used by
 * tools/export-moves.ts for the movement packs (docs/MOVEMENT.md §2.2).
 */
export function createPackDocument(template: Document, name: string): Document {
  const doc = new Document()
  doc.createBuffer()
  doc.getRoot().getAsset().generator = 'silkroad-web optimize (animation pack)'
  const scene = doc.createScene(name)
  const skin = template.getRoot().listSkins()[0]!
  const joints = new Set(skin.listJoints())
  const map = new Map<Node, Node>()
  const copy = (src: Node): Node => {
    const n = doc.createNode(src.getName()).setTranslation(src.getTranslation()).setRotation(src.getRotation()).setScale(src.getScale())
    map.set(src, n)
    for (const c of src.listChildren()) if (joints.has(c) || c.listChildren().some(d => joints.has(d))) n.addChild(copy(c))
    return n
  }
  const roots = skin.listJoints().filter(j => !j.getParentNode() || !joints.has(j.getParentNode()!))
  for (const r of roots) scene.addChild(copy(r))
  doc.getRoot().setDefaultScene(scene)
  return doc
}

function copyAnimation(src: Animation, dst: Document, name: string): void {
  const nodes = new Map(dst.getRoot().listNodes().map(n => [n.getName(), n]))
  const buffer = dst.getRoot().listBuffers()[0]!
  const anim = dst.createAnimation(name)
  const samplers = new Map<AnimationSampler, AnimationSampler>()
  for (const ch of src.listChannels()) {
    const target = nodes.get(ch.getTargetNode()!.getName())
    if (!target) throw new Error(`pack has no joint ${ch.getTargetNode()!.getName()}`)
    const s = ch.getSampler()!
    let ds = samplers.get(s)
    if (!ds) {
      const input = dst.createAccessor().setType('SCALAR').setArray(s.getInput()!.getArray()!.slice()).setBuffer(buffer)
      const out = s.getOutput()!
      const output = dst.createAccessor().setType(out.getType()).setArray(out.getArray()!.slice()).setNormalized(out.getNormalized()).setBuffer(buffer)
      ds = dst.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(s.getInterpolation())
      anim.addSampler(ds)
      samplers.set(s, ds)
    }
    anim.addChannel(dst.createAnimationChannel().setTargetNode(target).setTargetPath(ch.getTargetPath()!).setSampler(ds))
  }
}

/** Lossless finishing for packs: shared identical key arrays, then meshopt byte coding without filters. */
export async function finishPack(doc: Document): Promise<void> {
  await doc.transform(dedup({ keepUniqueNames: true }), prune({ keepLeaves: true }))
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })
}

/** Removes every animation (and what only they used) from a character document. */
export async function stripAnimations(doc: Document): Promise<void> {
  for (const a of doc.getRoot().listAnimations()) {
    for (const s of a.listSamplers()) {
      s.getInput()?.dispose()
      s.getOutput()?.dispose()
      s.dispose()
    }
    for (const c of a.listChannels()) c.dispose()
    a.dispose()
  }
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true, keepIndices: true, keepSolidTextures: true, keepExtras: true }))
}

// ---- sampling (glTF semantics) and equality ----

export function sampleChannel(s: AnimationSampler, t: number, out: number[]): number[] {
  const input = s.getInput()!
  const output = s.getOutput()!
  const times = input.getArray()!
  const n = times.length
  const size = output.getElementSize()
  const a: number[] = []
  const b: number[] = []
  const cubic = s.getInterpolation() === 'CUBICSPLINE'
  const at = (i: number, dst: number[]) => output.getElement(cubic ? i * 3 + 1 : i, dst)
  if (t <= times[0]! || n === 1) return (at(0, out), out)
  if (t >= times[n - 1]!) return (at(n - 1, out), out)
  let i = 0
  while (i < n - 2 && t >= times[i + 1]!) i++
  at(i, a)
  if (s.getInterpolation() === 'STEP') return (out.splice(0, out.length, ...a), out)
  at(i + 1, b)
  const u = (t - times[i]!) / (times[i + 1]! - times[i]!)
  out.length = size
  if (size === 4) {
    let dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!
    const sign = dot < 0 ? -1 : 1
    dot *= sign
    let k0 = 1 - u
    let k1 = u * sign
    if (dot < 0.9995) {
      const th = Math.acos(dot)
      const st = Math.sin(th)
      k0 = Math.sin((1 - u) * th) / st
      k1 = (Math.sin(u * th) / st) * sign
    }
    for (let c = 0; c < 4; c++) out[c] = a[c]! * k0 + b[c]! * k1
  } else {
    for (let c = 0; c < size; c++) out[c] = a[c]! + (b[c]! - a[c]!) * u
  }
  return out
}

export interface ClipCompare {
  channels: number
  samples: number
  /** Max absolute difference of any sampled component (0 = identical). */
  maxDiff: number
  missing: string[]
  extra: string[]
}

/** Samples every channel of both clips at every key time of the original and at each key midpoint. */
export function compareClips(original: Animation, candidate: Animation): ClipCompare {
  const key = (n: Node | null, p: string | null) => `${n?.getName() ?? '?'}|${p}`
  const cand = new Map(candidate.listChannels().map(c => [key(c.getTargetNode(), c.getTargetPath()), c]))
  const seen = new Set<string>()
  const res: ClipCompare = { channels: 0, samples: 0, maxDiff: 0, missing: [], extra: [] }
  const x: number[] = []
  const y: number[] = []
  for (const ch of original.listChannels()) {
    const k = key(ch.getTargetNode(), ch.getTargetPath())
    const other = cand.get(k)
    if (!other) {
      res.missing.push(k)
      continue
    }
    seen.add(k)
    res.channels++
    const sa = ch.getSampler()!
    const sb = other.getSampler()!
    if (sa.getInterpolation() !== sb.getInterpolation()) res.maxDiff = Infinity
    const times = [...sa.getInput()!.getArray()!]
    const probe = times.flatMap((t, i) => (i + 1 < times.length ? [t, (t + times[i + 1]!) / 2] : [t]))
    for (const t of probe) {
      sampleChannel(sa, t, x)
      sampleChannel(sb, t, y)
      for (let c = 0; c < x.length; c++) {
        const d = Math.abs(x[c]! - y[c]!)
        if (!(d <= res.maxDiff)) res.maxDiff = Number.isNaN(d) ? Infinity : d
      }
      res.samples++
    }
  }
  for (const k of cand.keys()) if (!seen.has(k)) res.extra.push(k)
  return res
}
