import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { bskMath, bskWorldTransforms, parseBsk, type BskSkeleton, type BskTransform } from '@sro/formats'
import { ARCHIVES, openArchive, REPO_ROOT } from '../src/node-io.ts'

const { quatAngleBetween, quatConjugate, quatLength, rigidCompose, rigidInverse, vec3Distance } = bskMath

/** Files that cannot parse, and why. Everything else in the corpus must. */
const ALLOWLIST = new Map([
  ['Data:prim/ani/mob/god/elemental/elemental_stand01.bsk', 'empty file (0 bytes)'],
  ['Data:prim/ani/mob/god/ghost_gluttony/ghost_gluttony_die.bsk', 'empty file (0 bytes)'],
  ['Data:prim/mesh/npc/npc_eu_carnival.bsk', 'empty file (0 bytes)'],
])
/** The one non-JMXV file: "BSK " + u32 101 header, NUL after every non-empty string. It parses. */
const LEGACY_FILE = 'Data:prim/skel/item/common/mob_select.bsk'

/**
 * Consistent caches: rotations agree to float32 round-off (<= ~3e-7 rad) and translations to <= ~3e-6 relative,
 * with 5 near misses up to ~1e-4. Stale caches start at 3.2e-4 relative. The test prints the actual ratios.
 */
const ROT_TOL = 1e-5 // radians
const POS_TOL = 1e-4 // relative to max(1, |expected translation|)

interface Entry {
  key: string
  size: number
  skeleton?: BskSkeleton
  error?: string
}

interface Err {
  rot: number
  pos: number
}

function error(actual: BskTransform, expected: BskTransform): Err {
  return {
    rot: quatAngleBetween(actual.rotation, expected.rotation),
    pos: vec3Distance(actual.translation, expected.translation) / Math.max(1, Math.hypot(...expected.translation)),
  }
}
/** Error as a multiple of the tolerance; below 1 is consistent. */
const excess = (e: Err) => Math.max(e.rot / ROT_TOL, e.pos / POS_TOL)
const within = (e: Err) => excess(e) < 1
const isIdentity = (t: BskTransform) => t.rotation.join() === '0,0,0,1' && t.translation.join() === '0,0,0'
const fmt = (x: number) => x.toExponential(2)

type Composer = (parent: BskTransform, local: BskTransform) => BskTransform
const asStored = (t: BskTransform) => t
const conjugated = (t: BskTransform): BskTransform => ({ rotation: quatConjugate(t.rotation), translation: t.translation })
const wxyz = (t: BskTransform): BskTransform => {
  const [a, b, c, d] = t.rotation
  return { rotation: [b, c, d, a], translation: t.translation }
}
const parentAfterLocal: Composer = (p, l) => rigidCompose(p, l)
const localAfterParent: Composer = (p, l) => rigidCompose(l, p)
/** Candidate readings of "toOrigin = f(parent.toOrigin, toParent)". Only the first survives the corpus. */
const HYPOTHESES: Array<[string, (t: BskTransform) => BskTransform, Composer]> = [
  ['x,y,z,w; parent after local (column P*L, D3D row L*P)', asStored, parentAfterLocal],
  ['x,y,z,w; local after parent', asStored, localAfterParent],
  ['x,y,z,w conjugated; parent after local', conjugated, parentAfterLocal],
  ['x,y,z,w conjugated; local after parent', conjugated, localAfterParent],
  ['w,x,y,z; parent after local', wxyz, parentAfterLocal],
  ['w,x,y,z; local after parent', wxyz, localAfterParent],
]

function formatTree(skeleton: BskSkeleton): string {
  const world = bskWorldTransforms(skeleton)
  const lines: string[] = []
  const walk = (i: number, depth: number) => {
    const bone = skeleton.bones[i]!
    const p = world[i]!.translation.map(v => v.toFixed(2)).join(', ')
    lines.push(`${'  '.repeat(depth)}${bone.name}${bone.type !== 0 ? ` [type ${bone.type}]` : ''}  @ (${p})`)
    for (const c of bone.childIndices) {
      if (c >= 0 && skeleton.bones[c]!.parentIndex === i) walk(c, depth + 1)
    }
  }
  skeleton.bones.forEach((bone, i) => {
    if (bone.parentIndex < 0) walk(i, 0)
  })
  return lines.join('\n')
}

/** The skeleton path a BSR references: the length-prefixed string ending in ".bsk". */
function bskPathInBsr(bytes: Uint8Array): string {
  const text = new TextDecoder('latin1').decode(bytes)
  const end = text.toLowerCase().indexOf('.bsk') + 4
  if (end < 4) throw new Error('no .bsk reference in BSR')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let start = end - 1; start >= 4; start--) {
    if (view.getUint32(start - 4, true) === end - start) return text.slice(start, end)
  }
  throw new Error('no length-prefixed .bsk reference in BSR')
}

describe.skipIf(!existsSync(join(REPO_ROOT, 'sro.config.json')))('BSK corpus (every archive)', () => {
  const entries: Entry[] = []
  let parsed: Array<Entry & { skeleton: BskSkeleton }> = []

  beforeAll(() => {
    // A magic scan of the full extraction finds BSK data only in .bsk files, and only in Data and Particles.
    for (const name of ARCHIVES) {
      const archive = openArchive(name)
      for (const [path, file] of archive.files) {
        if (!path.toLowerCase().endsWith('.bsk')) continue
        const entry: Entry = { key: `${name}:${path}`, size: file.size }
        try {
          entry.skeleton = parseBsk(archive.read(file))
        } catch (e) {
          entry.error = (e as Error).message
        }
        entries.push(entry)
      }
    }
    parsed = entries.filter((e): e is Entry & { skeleton: BskSkeleton } => e.skeleton !== undefined)
  })

  it('parses every skeleton except the allowlisted empty files', () => {
    const failures = entries.filter(e => e.error !== undefined)
    for (const f of failures) {
      if (!ALLOWLIST.has(f.key)) console.log(`unexpected failure ${f.key}: ${f.error}`)
    }
    expect(failures.map(f => f.key).sort()).toEqual([...ALLOWLIST.keys()].sort())
    for (const f of failures) expect(f.size).toBe(0)

    // Census of vSRO 1.188 (work/census.json): Data 806 JMXVBSK 0101 + 1 "BSK " + 3 empty, Particles 1.
    const signatures: Record<string, number> = {}
    for (const { key, skeleton: s } of parsed) {
      const label = `${key.slice(0, key.indexOf(':'))} ${s.signature}`
      signatures[label] = (signatures[label] ?? 0) + 1
    }
    expect(signatures).toEqual({ 'Data JMXVBSK 0101': 806, 'Data BSK ': 1, 'Particles JMXVBSK 0101': 1 })
    expect(entries.length).toBe(811)
    const legacy = parsed.find(e => e.skeleton.signature === 'BSK ')!
    expect(legacy.key).toBe(LEGACY_FILE)
    // From the hexdump: a three-bone chain Bone01 -> Bone02 -> Bone03 with unit quaternions after each NUL.
    expect(legacy.skeleton.bones.map(b => [b.name, b.parentName, b.childNames])).toEqual([
      ['Bone01', '', ['Bone02']],
      ['Bone02', 'Bone01', ['Bone03']],
      ['Bone03', 'Bone02', []],
    ])
    expect(legacy.skeleton.bones[0]!.toParent.rotation).toEqual([-0.5, -0.5, 0.5, 0.5])

    // A misaligned read would surface as control bytes, U+FFFD or implausible lengths in some name.
    let longest = 0
    for (const { key, skeleton: s } of parsed) {
      for (const b of s.bones) {
        expect(b.name, `${key}: bone name`).toMatch(/^[\x20-\x7e]+$/)
        for (const n of [b.parentName, ...b.childNames]) expect(n, `${key}: ${b.name} link`).toMatch(/^[\x20-\x7e]*$/)
        for (const n of b.childNames) expect(n.length, `${key}: ${b.name} empty child name`).toBeGreaterThan(0)
        longest = Math.max(longest, b.name.length)
      }
    }
    expect(longest).toBeLessThanOrEqual(64)
    for (const { skeleton: s } of parsed) {
      expect(s.version).toBe(101)
      expect([s.unknown0, s.unknown1]).toEqual([0, 0])
      for (const b of s.bones) expect(b.type).toBe(0)
    }

    const buckets: Array<[string, number, number]> = [
      ['1', 1, 1], ['2-5', 2, 5], ['6-10', 6, 10], ['11-20', 11, 20], ['21-30', 21, 30], ['31-40', 31, 40],
      ['41-50', 41, 50], ['51-60', 51, 60], ['61-80', 61, 80], ['81-100', 81, 100], ['101-200', 101, 200],
      ['>200', 201, Infinity],
    ]
    const counts = parsed.map(e => e.skeleton.bones.length)
    const histogram = Object.fromEntries(buckets.map(([label, lo, hi]) => [label, counts.filter(n => n >= lo && n <= hi).length]))
    const total = counts.reduce((a, b) => a + b, 0)
    console.log(
      `BSK: ${entries.length} files, ${parsed.length} parsed, ${failures.length} allowlisted ` +
        `(${[...new Set(ALLOWLIST.values())].join('; ')}), ${total} bones ` +
        `(min ${Math.min(...counts)}, max ${Math.max(...counts)}), ` +
        `all bone type 0 (CPrimBone), footer 0/0 everywhere\nbone-count histogram: ${JSON.stringify(histogram)}`,
    )
  })

  it('has a well-formed bone graph', () => {
    let superRoots = 0
    let multiRoot = 0
    let parentsFirst = 0
    for (const { key, skeleton: s } of parsed) {
      const names = s.bones.map(b => b.name)
      expect(new Set(names).size, `${key}: duplicate bone names`).toBe(names.length)
      s.bones.forEach((bone, i) => {
        if (bone.parentName === '') expect(bone.parentIndex).toBe(-1)
        else expect(bone.parentIndex, `${key}: ${bone.name} parent ${bone.parentName}`).toBeGreaterThanOrEqual(0)
        expect(bone.childIndices, `${key}: ${bone.name} children`).not.toContain(-1)
        // Child lists mirror parent links, except a synthetic "[root]" that lists the real roots (parentName '').
        for (const c of bone.childIndices) {
          const child = s.bones[c]!
          if (child.parentIndex !== i) {
            expect(bone.name, `${key}: ${bone.name} lists ${child.name}`).toBe('[root]')
            expect(child.parentName).toBe('')
          }
        }
        if (bone.parentIndex >= 0) expect(s.bones[bone.parentIndex]!.childNames).toContain(bone.name)
      })
      // Acyclic: walking parents from any bone terminates.
      for (const bone of s.bones) {
        let steps = 0
        for (let j = bone.parentIndex; j >= 0; j = s.bones[j]!.parentIndex) {
          expect(++steps, `${key}: parent cycle at ${bone.name}`).toBeLessThanOrEqual(s.bones.length)
        }
      }
      expect(() => bskWorldTransforms(s)).not.toThrow()
      if (names.includes('[root]')) superRoots++
      if (s.bones.filter(b => b.parentIndex < 0).length > 1) multiRoot++
      if (s.bones.every((b, i) => b.parentIndex < i)) parentsFirst++
    }
    console.log(
      `BSK graph: ${multiRoot} multi-root skeletons, ${superRoots} of them with a synthetic "[root]"; ` +
        `${parentsFirst}/${parsed.length} store every parent before its children`,
    )
  })

  it('stores finite, unit quaternions', () => {
    let maxDeviation = 0
    for (const { skeleton: s } of parsed) {
      for (const b of s.bones) {
        for (const t of [b.toParent, b.toOrigin, b.toLocal]) {
          expect([...t.rotation, ...t.translation].every(Number.isFinite)).toBe(true)
          maxDeviation = Math.max(maxDeviation, Math.abs(quatLength(t.rotation) - 1))
        }
      }
    }
    console.log(`BSK quaternions: max ||q| - 1| = ${fmt(maxDeviation)}`)
    expect(maxDeviation).toBeLessThan(1e-6)
  })

  it('caches toOrigin = rigidCompose(parent.toOrigin, toParent) and toLocal = rigidInverse(toOrigin)', () => {
    // 1. Which quaternion order and multiplication order explain the stored caches?
    const hits = HYPOTHESES.map(() => 0)
    let nonRoot = 0
    for (const { skeleton: s } of parsed) {
      for (const bone of s.bones) {
        if (bone.parentIndex < 0) continue
        nonRoot++
        const parent = s.bones[bone.parentIndex]!
        HYPOTHESES.forEach(([, read, compose], h) => {
          if (within(error(read(bone.toOrigin), compose(read(parent.toOrigin), read(bone.toParent))))) hits[h]!++
        })
      }
    }
    console.log(
      `BSK composition hypotheses (non-root bones whose toOrigin matches, of ${nonRoot}):\n` +
        HYPOTHESES.map(([name], h) => `  ${hits[h]!.toString().padStart(6)}  ${name}`).join('\n'),
    )
    expect(hits[0]).toBeGreaterThan(0.93 * nonRoot)
    for (const h of hits.slice(1)) expect(h).toBeLessThan(0.01 * nonRoot)

    // 2. Under that convention, measure every bone's stored caches.
    let bones = 0
    let offChain = 0
    const ok = { origin: 0, local: 0, chainOrigin: 0, chainLocal: 0 }
    let maxOk: Err = { rot: 0, pos: 0 }
    let maxOkExcess = 0
    let nearMisses = 0
    let minStaleExcess = Infinity
    let staleSpineBase = 0
    const staleByName: Record<string, number> = {}
    const staleFiles = new Set<string>()
    for (const { key, skeleton: s } of parsed) {
      const world = bskWorldTransforms(s)
      s.bones.forEach((bone, i) => {
        bones++
        const parent = bone.parentIndex < 0 ? undefined : s.bones[bone.parentIndex]!
        const origin = error(bone.toOrigin, parent ? rigidCompose(parent.toOrigin, bone.toParent) : bone.toParent)
        const local = error(bone.toLocal, rigidInverse(bone.toOrigin))
        const chainOrigin = error(bone.toOrigin, world[i]!)
        const chainLocal = error(bone.toLocal, rigidInverse(world[i]!))
        for (const e of [origin, local]) {
          if (within(e)) {
            maxOk = { rot: Math.max(maxOk.rot, e.rot), pos: Math.max(maxOk.pos, e.pos) }
            maxOkExcess = Math.max(maxOkExcess, excess(e))
            if (excess(e) > 0.1) nearMisses++
          } else {
            minStaleExcess = Math.min(minStaleExcess, excess(e))
          }
        }
        if (within(origin)) ok.origin++
        if (within(local)) ok.local++
        if (within(chainOrigin)) ok.chainOrigin++
        if (within(chainLocal)) ok.chainLocal++
        if (!within(chainOrigin) || !within(chainLocal)) {
          offChain++
          staleByName[bone.name] = (staleByName[bone.name] ?? 0) + 1
          staleFiles.add(key)
        }
        // The systematic case: an inserted identity "Spine_Base" whose toOrigin was left at identity
        // (so its children fail the one-step check), while its toLocal is right.
        if (bone.name === 'Spine_Base' && !within(chainOrigin)) {
          staleSpineBase++
          expect(isIdentity(bone.toOrigin)).toBe(true)
          expect(isIdentity(bone.toParent)).toBe(true)
          expect(within(chainLocal)).toBe(true)
        }
      })
    }
    const pct = (n: number) => `${n}/${bones} (${((100 * n) / bones).toFixed(2)}%)`
    const topStale = Object.entries(staleByName).sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log(
      `BSK stored-transform consistency (tolerance ${ROT_TOL} rad, ${POS_TOL} relative translation):\n` +
        `  toOrigin == rigidCompose(parent.toOrigin, toParent)  ${pct(ok.origin)}\n` +
        `  toLocal  == rigidInverse(toOrigin)                   ${pct(ok.local)}\n` +
        `  toOrigin == toParent chain (bskWorldTransforms)      ${pct(ok.chainOrigin)}\n` +
        `  toLocal  == rigidInverse(toParent chain)             ${pct(ok.chainLocal)}\n` +
        `  max error of consistent caches: ${fmt(maxOk.rot)} rad, ${fmt(maxOk.pos)} relative ` +
        `(${nearMisses} above 0.1x tolerance)\n` +
        `  error / tolerance: consistent <= ${maxOkExcess.toFixed(3)}, stale >= ${minStaleExcess.toFixed(2)}\n` +
        `  bones whose toOrigin or toLocal is off the toParent chain: ${offChain} in ${staleFiles.size} files ` +
        `(Spine_Base with identity toOrigin: ${staleSpineBase}); by name: ${JSON.stringify(topStale)}`,
    )
    expect(ok.origin).toBeGreaterThan(0.94 * bones)
    expect(ok.local).toBeGreaterThan(0.97 * bones)
    expect(ok.chainLocal).toBeGreaterThan(0.97 * bones)
    expect(maxOk.rot).toBeLessThan(1e-6)
    expect(nearMisses).toBeLessThanOrEqual(10)
    expect(minStaleExcess).toBeGreaterThan(3)
  })

  it('prints the bone trees of the test characters', () => {
    const data = openArchive('Data')
    for (const bsr of ['res/char/china/chinaman_adventurer.bsr', 'res/mob/china/tiger.bsr']) {
      const bskPath = bskPathInBsr(data.read(bsr))
      const skeleton = parseBsk(data.read(bskPath))
      console.log(`${bsr} -> ${bskPath} (${skeleton.bones.length} bones, world positions from toParent)\n${formatTree(skeleton)}`)
      expect(skeleton.bones.length).toBeGreaterThan(20)
    }
  })
})
