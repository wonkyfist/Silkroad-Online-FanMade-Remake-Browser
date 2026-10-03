import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BinaryReader, eucKr, latin1, normalizePk2Path, parseBan, type BanAnimation, type Pk2Archive } from '@sro/formats'
import { beforeAll, describe, expect, it } from 'vitest'
import { ARCHIVES, openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasClient = existsSync(join(REPO_ROOT, 'sro.config.json'))

/**
 * Tracks in the retail data whose every key is rotation (-0.7071, 0, 0, 0) (length 0.7071) with NaN translations
 * (0xffc00000 in the penguin files, 0x7fc00000 in flame_adjutant). Broken exports, returned raw by the parser.
 */
const DEGENERATE_TRACKS = [
  'prim/ani/cos/p_penguin01/p_penguin01_run.ban|Bip01 L Finger0',
  'prim/ani/cos/p_penguin01/p_penguin01_run.ban|Bip01 R Finger0',
  'prim/ani/cos/p_penguin01/p_penguin01_stand02.ban|Bip01 L Finger0',
  'prim/ani/cos/p_penguin01/p_penguin01_stand02.ban|Bip01 R Finger0',
  'prim/ani/cos/p_penguin01/p_penguin01_walk.ban|Bip01 L Finger0',
  'prim/ani/mob/god/flame_adjutant_die.ban|Bip01 R Finger1',
  'prim/ani/mob/god/flame_adjutant_die.ban|Bip01 R Finger11',
  'prim/ani/mob/god/flame_adjutant_die.ban|Bip01 R Finger2',
  'prim/ani/mob/god/flame_adjutant_die.ban|Bip01 R Finger21',
]

interface Parsed {
  archive: string
  path: string
  anim: BanAnimation
}

const inc = (map: Map<string | number, number>, key: string | number) => map.set(key, (map.get(key) ?? 0) + 1)
const table = (map: Map<string | number, number>) =>
  [...map].sort((a, b) => (typeof a[0] === 'number' && typeof b[0] === 'number' ? a[0] - b[0] : 0)).map(([k, n]) => `${k}: ${n}`).join(', ')

describe.skipIf(!hasClient)('BAN corpus (every archive)', () => {
  const parsed: Parsed[] = []
  const failures: string[] = []

  beforeAll(() => {
    // A signature scan of the full extraction finds BAN data only in .ban files, and only in Data and Particles.
    for (const name of ARCHIVES) {
      const archive = openArchive(name)
      for (const [path, file] of archive.files) {
        if (!path.toLowerCase().endsWith('.ban')) continue
        try {
          parsed.push({ archive: name, path, anim: parseBan(archive.read(file)) })
        } catch (e) {
          failures.push(`${name}:${path}: ${(e as Error).message}`)
        }
      }
    }
  })

  it('parses every file without exceptions', () => {
    expect(failures).toEqual([])
    const versions = new Map<string, number>()
    for (const p of parsed) inc(versions, `${p.archive} ${p.anim.signature}`)
    // Census of vSRO 1.188: the lone "BAN " file is the orphaned prim/ani/item/common/mob_select.ban.
    expect(Object.fromEntries(versions)).toEqual({
      'Data JMXVBAN 0102': 3561,
      'Data JMXVBAN 0101': 2,
      'Data BAN ': 1,
      'Particles JMXVBAN 0102': 102,
    })
    expect(parsed.find(p => p.anim.signature === 'BAN ')?.path).toBe('prim/ani/item/common/mob_select.ban')
  })

  it('keeps the 0102 reserved ints at 0 and animationType in {0, 1}', () => {
    for (const { anim } of parsed) {
      if (anim.version === 102) expect([anim.unknown0, anim.unknown1]).toEqual([0, 0])
      else expect([anim.unknown0, anim.unknown1]).toEqual([null, null])
      expect([0, 1]).toContain(anim.animationType)
    }
  })

  it('decodes every name cleanly: bone names ASCII, one Korean animation name', () => {
    const nonAscii: string[] = []
    for (const { path, anim } of parsed) {
      expect(anim.name, path).not.toContain('�')
      expect(anim.name.length, path).toBeGreaterThan(0)
      if (/[^\x20-\x7e]/.test(anim.name)) nonAscii.push(`${path}: ${anim.name}`)
      for (const track of anim.tracks) expect(track.boneName, path).toMatch(/^[\x20-\x7e]+$/)
    }
    expect(nonAscii).toEqual(['prim/ani/avatar/nasrun1_man_run.ban: 남자나스룬뛰기'])
  })

  it('has one key per key time on every track, with non-decreasing times', () => {
    let duplicateFiles = 0
    const nonZeroStart: string[] = []
    for (const { path, anim } of parsed) {
      expect(anim.sharedKeyTimes, path).toBe(true)
      expect(anim.keyTimes.length, path).toBeGreaterThan(0)
      expect(anim.tracks.length, path).toBeGreaterThan(0)
      for (const track of anim.tracks) {
        expect(track.keyTimes).toBe(anim.keyTimes)
        expect(track.rotations.length).toBe(anim.keyTimes.length * 4)
        expect(track.translations.length).toBe(anim.keyTimes.length * 3)
        if (track.unknownKeyTimes) expect(Array.from(track.unknownKeyTimes)).toEqual(Array.from(track.keyTimes))
      }
      let duplicate = false
      for (let i = 1; i < anim.keyTimes.length; i++) {
        expect(anim.keyTimes[i]!, path).toBeGreaterThanOrEqual(anim.keyTimes[i - 1]!)
        if (anim.keyTimes[i] === anim.keyTimes[i - 1]) duplicate = true
      }
      if (duplicate) duplicateFiles++
      if (anim.keyTimes[0] !== 0) nonZeroStart.push(`${path} starts at ${anim.keyTimes[0]} ms`)
    }
    expect(nonZeroStart).toEqual(['prim/ani/mob/china/tigerwoman/tigerwoman_damage02.ban starts at 67 ms'])
    console.log(`[ban] key times: ${duplicateFiles} files repeat a time (non-strict); first key != 0: ${nonZeroStart.join('; ')}`)
  })

  it('stores durationMs within 1 ms of the last key time', () => {
    const delta = new Map<string | number, number>()
    let frameRule = 0
    const perFrame = new Map<string | number, number>()
    for (const { path, anim } of parsed) {
      const last = anim.keyTimes[anim.keyTimes.length - 1]!
      const d = anim.durationMs - last
      expect(Math.abs(d), path).toBeLessThanOrEqual(1)
      inc(delta, d)
      // The exporter floors frames * 1000 / fps for the duration, while the last key is sometimes rounded up.
      const frames = Math.round((last * anim.fps) / 1000)
      if (anim.durationMs === Math.floor((frames * 1000) / anim.fps)) frameRule++
      const frameCount = Math.round((anim.durationMs * anim.fps) / 1000) + 1
      inc(perFrame, anim.keyTimes.length === frameCount ? 'one key per frame' : anim.keyTimes.length < frameCount ? 'fewer keys than frames' : 'more keys than frames')
    }
    expect(frameRule).toBeGreaterThan(parsed.length - 10)
    console.log(
      `[ban] durationMs - lastKeyTime: ${table(delta)}\n` +
        `[ban] durationMs == floor(round(lastKey * fps / 1000) * 1000 / fps): ${frameRule}/${parsed.length}\n` +
        `[ban] keys vs frames (duration * fps / 1000 + 1): ${table(perFrame)}`,
    )
  })

  it('has unit quaternions and finite translations outside the known degenerate tracks', () => {
    let maxDeviation = 0
    let keys = 0
    const nearOne = [0, 0, 0, 0]
    const degenerate: string[] = []
    for (const { path, anim } of parsed) {
      for (const track of anim.tracks) {
        const { rotations: q, translations: t } = track
        const finite = t.every(Number.isFinite) && q.every(Number.isFinite)
        let trackMax = 0
        for (let k = 0; k < q.length; k += 4) {
          trackMax = Math.max(trackMax, Math.abs(Math.hypot(q[k]!, q[k + 1]!, q[k + 2]!, q[k + 3]!) - 1))
        }
        if (!finite || trackMax > 1e-3) {
          degenerate.push(`${path}|${track.boneName}`)
          expect(t.every(Number.isNaN)).toBe(true)
          for (let k = 0; k < q.length; k += 4) expect(Array.from(q.subarray(k, k + 4))).toEqual([-Math.fround(Math.SQRT1_2), 0, 0, 0])
          continue
        }
        maxDeviation = Math.max(maxDeviation, trackMax)
        keys += q.length / 4
        for (let k = 0; k < q.length; k += 4) {
          for (let c = 0; c < 4; c++) if (Math.abs(q[k + c]!) > 0.999) nearOne[c]!++
        }
      }
    }
    expect(degenerate.sort()).toEqual([...DEGENERATE_TRACKS].sort())
    expect(maxDeviation).toBeLessThan(1e-5)
    // Near-identity keys dominate bone animation, so w (the ~1 component) must be the last slot by a wide margin.
    expect(nearOne[3]!).toBeGreaterThan(20 * Math.max(nearOne[0]!, nearOne[1]!, nearOne[2]!))
    console.log(`[ban] keys with a component above 0.999, by slot x, y, z, w: ${nearOne.join(', ')}`)
    console.log(`[ban] ${keys} keys: max | |q| - 1 | = ${maxDeviation.toExponential(2)}; ${degenerate.length} degenerate tracks (q = (-0.7071, 0, 0, 0), t = NaN)`)
  })

  it('reports the corpus', () => {
    const version = new Map<string | number, number>()
    const type = new Map<string | number, number>()
    const fps = new Map<string | number, number>()
    const duration = new Map<string | number, number>()
    const buckets = [250, 500, 1000, 2000, 4000, 8000, 16000]
    let maxKeys = 0
    let maxTracks = 0
    let totalKeys = 0
    for (const { anim } of parsed) {
      inc(version, anim.signature)
      inc(type, anim.animationType === 0 ? '0 one-shot' : anim.animationType === 1 ? '1 cyclic' : anim.animationType)
      inc(fps, anim.fps)
      const bucket = buckets.find(b => anim.durationMs < b)
      inc(duration, bucket === undefined ? `>=${buckets.at(-1)} ms` : `<${bucket} ms`)
      maxKeys = Math.max(maxKeys, anim.keyTimes.length)
      maxTracks = Math.max(maxTracks, anim.tracks.length)
      totalKeys += anim.keyTimes.length * anim.tracks.length
    }
    const longest = parsed.reduce((a, b) => (b.anim.durationMs > a.anim.durationMs ? b : a))
    console.log(
      [
        `[ban] ${parsed.length} files, ${totalKeys} track keys; max ${maxKeys} key times, max ${maxTracks} tracks`,
        `[ban] versions: ${table(version)}`,
        `[ban] animationType: ${table(type)}`,
        `[ban] fps: ${table(fps)}`,
        `[ban] duration: ${[...duration].sort((a, b) => parseInt(String(a[0]).replace(/\D/g, '')) - parseInt(String(b[0]).replace(/\D/g, ''))).map(([k, n]) => `${k}: ${n}`).join(', ')}`,
        `[ban] longest: ${longest.path} (${longest.anim.durationMs} ms)`,
      ].join('\n'),
    )
    expect(parsed.length).toBeGreaterThan(0)
  })
})

/** Length-prefixed ASCII strings ending in `ext` found anywhere in a file (e.g. resource paths in a BSR). */
function referencedPaths(bytes: Uint8Array, ext: string): string[] {
  const text = latin1.decode(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: string[] = []
  const pattern = new RegExp(`[\\x20-\\x7e]+\\${ext}`, 'gi')
  for (const m of text.matchAll(pattern)) {
    if (m.index >= 4 && view.getUint32(m.index - 4, true) === m[0].length) out.push(m[0])
  }
  return out
}

/**
 * Crude JMXVBSK reader (the real BSK parser lives in bsk.ts): bone name -> length of its bind-pose translation
 * to the parent (the first of the three rotation + translation pairs).
 */
function bskBones(bytes: Uint8Array): Map<string, number> {
  const r = new BinaryReader(bytes)
  expect(latin1.decode(r.bytesView(12))).toMatch(/^JMXVBSK /)
  const bones = new Map<string, number>()
  const count = r.u32()
  for (let i = 0; i < count; i++) {
    r.u8() // bone type
    const name = r.lpString(eucKr)
    r.lpString(eucKr) // parent
    r.skip(16) // to-parent rotation
    bones.set(name, Math.hypot(r.f32(), r.f32(), r.f32()))
    r.skip(2 * 28) // to-origin, to-local rotation + translation
    const children = r.u32()
    for (let c = 0; c < children; c++) r.lpString(eucKr)
  }
  return bones
}

/**
 * Bones whose animated offset from the parent may change length. The root moves freely, the pelvis and thighs
 * are re-seated by Biped, and the HandMid weapon-attach bones slide. Every other bone must keep its bind length.
 */
const STRETCHING_BONES = new Set(['Bip01', 'Bip01 Pelvis', 'Bip01 L Thigh', 'Bip01 R Thigh', 'Bip01 L HandMid', 'Bip01 R HandMid'])

describe.skipIf(!hasClient)('BAN tracks vs the character skeleton', () => {
  let data: Pk2Archive

  beforeAll(() => {
    data = openArchive('Data')
  })

  it('chinaman_adventurer.bsr: every animated bone exists in its .bsk (or the avatar wing it drives)', () => {
    const bsr = data.read('res/char/china/chinaman_adventurer.bsr')
    const skeletons = referencedPaths(bsr, '.bsk')
    expect(skeletons).toEqual(['prim\\skel\\char\\europe\\europeman_skel.bsk'])
    const bones = bskBones(data.read(normalizePk2Path(skeletons[0]!)))
    const banPaths = [...new Set(referencedPaths(bsr, '.ban').map(normalizePk2Path))]
    expect(banPaths.length).toBeGreaterThan(100)

    const summary: string[] = []
    const missing = new Map<string, string[]>()
    const animatedBones = new Set<string>()
    let rigidKeys = 0
    let maxStretch = 0
    banPaths.forEach((path, i) => {
      const anim = parseBan(data.read(path))
      for (const track of anim.tracks) {
        animatedBones.add(track.boneName)
        const bindLength = bones.get(track.boneName)
        if (bindLength === undefined) missing.set(path, [...(missing.get(path) ?? []), track.boneName])
        else if (!STRETCHING_BONES.has(track.boneName)) {
          // Translations are bone-local: their length is the bone length from the skeleton's bind pose.
          const t = track.translations
          for (let k = 0; k < t.length; k += 3) {
            maxStretch = Math.max(maxStretch, Math.abs(Math.hypot(t[k]!, t[k + 1]!, t[k + 2]!) - bindLength))
            rigidKeys++
          }
        }
      }
      if (i % Math.ceil(banPaths.length / 10) === 0) {
        const type = anim.animationType === 1 ? 'cyclic' : 'one-shot'
        summary.push(
          `  ${anim.name.padEnd(34)} ${type.padEnd(8)} ${String(anim.durationMs).padStart(5)} ms @${anim.fps}fps  ${String(anim.keyTimes.length).padStart(3)} keys  ${anim.tracks.length} bones`,
        )
      }
    })
    // man_avatar_fly animates the body plus the 23 bones of the devil-wing avatar attachment in one file.
    const fly = 'prim/ani/char/china/man/man_avatar_fly.ban'
    expect([...missing.keys()]).toEqual([fly])
    const wing = [...bskBones(data.read('prim/skel/etc/avatar_m_devil_wing.bsk')).keys()]
    expect([...missing.get(fly)!].sort()).toEqual([...wing].sort())
    expect(rigidKeys).toBeGreaterThan(150_000)
    expect(maxStretch).toBeLessThan(1e-2)
    console.log(
      `[ban] ${skeletons[0]}: ${bones.size} bones; ${banPaths.length} animations animate ${animatedBones.size} distinct bones; ` +
        `all in the skeleton except ${fly}'s ${wing.length} avatar_m_devil_wing.bsk bones\n` +
        `[ban] ${rigidKeys} keys of non-root bones keep the bind bone length (max deviation ${maxStretch.toExponential(2)})\n` +
        summary.join('\n'),
    )
  })
})
