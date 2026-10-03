import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  bsrReferencedPaths,
  formatBsr,
  normalizePk2Path,
  parseBsr,
  type BsrResource,
  type Pk2Archive,
} from '@sro/formats'
import { ARCHIVES, openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

/** Files allowed to fail parsing, with the reason. None in vSRO 1.188. */
const PARSE_ALLOWLIST = new Map<string, string>()

const TEST_ASSETS = {
  character: 'res/char/china/chinaman_adventurer.bsr',
  weapon: 'res/item/china/weapon/blade_01.bsr',
  monster: 'res/mob/china/mangnyang.bsr',
}

type Counter = Map<string | number, number>
const inc = (map: Counter, key: string | number, n = 1) => map.set(key, (map.get(key) ?? 0) + n)
const sorted = (map: Counter) =>
  [...map].sort((a, b) => (typeof a[0] === 'number' && typeof b[0] === 'number' ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]))))
const table = (map: Counter) => sorted(map).map(([k, n]) => `${k}: ${n}`).join(', ')

describe.skipIf(!hasConfig)('BSR corpus (all archives)', () => {
  let archive: Pk2Archive
  const parsed: Array<{ path: string; res: BsrResource }> = []
  const failures: string[] = []
  const perArchive: Record<string, number> = {}
  let total = 0

  beforeAll(() => {
    archive = openArchive('Data')
    // Every archive is scanned; per the census only Data.pk2 holds .bsr files. Paths outside Data
    // get an 'Archive:' prefix (and would not resolve against Data below).
    for (const name of ARCHIVES) {
      const pk2 = openArchive(name)
      perArchive[name] = 0
      for (const [path, file] of pk2.files) {
        if (!path.toLowerCase().endsWith('.bsr')) continue
        const key = name === 'Data' ? path : `${name}:${path}`
        total++
        perArchive[name]++
        try {
          parsed.push({ path: key, res: parseBsr(pk2.read(file)) })
        } catch (e) {
          if (!PARSE_ALLOWLIST.has(key)) failures.push(`${key}: ${(e as Error).message}`)
        }
      }
    }
  })

  it('parses every .bsr without exceptions', () => {
    expect(failures).toEqual([])
    expect(perArchive).toEqual({ Data: 5563, Map: 0, Media: 0, Music: 0, Particles: 0 })
    expect(total).toBe(5563)
    expect(parsed.length + PARSE_ALLOWLIST.size).toBe(total)

    const versions: Counter = new Map()
    const types: Counter = new Map()
    const typeCategory: Counter = new Map()
    for (const { res } of parsed) {
      inc(versions, res.signature)
      inc(types, `${res.type} ${res.typeName ?? '?'}`)
      inc(typeCategory, `${res.typeName ?? res.type}/${res.categoryName ?? res.category}`)
    }
    console.log(`BSR: ${parsed.length}/${total} parsed`)
    console.log(`  versions: ${table(versions)}`)
    console.log(`  object types: ${table(types)}`)
    console.log(`  type/category: ${table(typeCategory)}`)
    expect(Object.fromEntries(versions)).toEqual({ 'JMXVRES 0109': 5559, 'JMXVRES 0108': 3, 'JMXVRES 0107': 1 })
    for (const { res } of parsed) expect(res.categoryName).toBe('RESOURCE')
  })

  it('consumes every file to EOF, with sections in the client order', () => {
    // parseBsr already throws when a section does not end exactly where the next one starts, so a
    // clean parse means every section (not only the last) was consumed byte-exactly.
    const trailing = parsed.filter(p => p.res.trailing.length > 0).map(p => `${p.path} (+${p.res.trailing.length})`)
    expect(trailing).toEqual([])
    const outOfOrder: string[] = []
    for (const { path, res } of parsed) {
      const h = res.header
      const order = [h.collisionOffset, h.materialOffset, h.meshOffset, h.animationOffset, h.skeletonOffset,
        h.primMeshGroupOffset, h.primAniGroupOffset, h.modPaletteOffset]
      if (order.some((v, i) => i > 0 && v <= order[i - 1]!)) outOfOrder.push(path)
      expect(h.reserved).toEqual([0, 0, 0])
      expect(res.animationTypeVersion).toBe(0x1000)
      expect(res.animationTypeUserDefine).toBe(0)
    }
    expect(outOfOrder).toEqual([])

    const meshFlags: Counter = new Map()
    const materialCounts: Counter = new Map()
    for (const { res } of parsed) {
      inc(meshFlags, res.header.primMeshFlag)
      inc(materialCounts, res.materials.length)
      if (res.header.primMeshFlag & 1) expect(res.meshes.every(m => m.flag !== null)).toBe(true)
    }
    console.log(`  primMeshFlag: ${table(meshFlags)}; material sets per file: ${table(materialCounts)}`)
  })

  it('holds field-level invariants in every file', () => {
    const bad: string[] = []
    const check = (ok: boolean, path: string, what: string) => {
      if (!ok && bad.length < 40) bad.push(`${path}: ${what}`)
    }
    const finite = (v: readonly number[]) => v.every(Number.isFinite)
    for (const { path, res } of parsed) {
      const legacy = res.version < 109
      check(res.header.modDataFlag === (res.version === 107 ? 1 : 0), path, `modDataFlag ${res.header.modDataFlag}`)
      check(res.reserved.every(b => b === 0), path, 'objInfo reserved bytes')
      check(res.collision.boundingBoxes.length === (legacy ? 1 : 2), path, 'AABB count')
      check(res.collision.boundingBoxes.every(b => finite(b.min) && finite(b.max)), path, 'AABB not finite')
      check(res.collision.hasMatrix === 0 ? res.collision.matrix === null : res.collision.matrix?.length === 16, path, 'matrix')
      check(res.collision.matrix === null || finite(res.collision.matrix), path, 'matrix not finite')
      const ids = res.materials.map(m => m.id)
      if (legacy) check(ids.length === 1 && ids[0] === null, path, 'legacy material')
      else check(ids.every(id => id !== null && id >= 0 && id <= 4) && new Set(ids).size === ids.length, path, `material ids ${ids}`)
      check(res.meshes.every(m => (m.flag !== null) === ((res.header.primMeshFlag & 1) === 1)), path, 'mesh flag presence')
      check(res.skeleton === null || res.skeleton.hasSkeleton === 1, path, 'hasSkeleton')
      check((res.legacyTimelines !== null) === (res.version === 107), path, 'legacyTimelines')
      for (const g of res.aniGroups) {
        for (const a of g.animations) {
          check(a.fileIndex >= -1 && a.fileIndex < res.animationPaths.length, path, `fileIndex ${a.fileIndex}`)
          check((a.path === null) === (a.fileIndex === -1), path, 'animation path')
          check(Number.isFinite(a.walkLength) && a.walkLength >= 0, path, `walkLength ${a.walkLength}`)
          // Normalized (x, y) in [0, 1], x non-decreasing: a misread count or field order breaks this.
          const graph = a.walkGraph
          check(graph.length >= 2, path, `walk graph of ${graph.length}`)
          check(graph.every(([x, y], i) => x >= 0 && x <= 1 && y >= 0 && y <= 1 && (i === 0 || x >= graph[i - 1]![0])),
            path, `walk graph ${JSON.stringify(graph)}`)
          check(a.events.every(e => e.timeMs < 60000 && e.p1 >= 0 && e.p2 >= 0), path, 'event fields')
        }
      }
      for (const s of res.modPalette.systemSets) check(s.animationType === (res.version === 107 ? null : -1), path, 'system set animType')
      for (const s of res.modPalette.aniSets) check(s.type === 1 && s.animationTypeName !== undefined, path, `ani set ${s.type}/${s.animationType}`)
      for (const s of [...res.modPalette.systemSets, ...res.modPalette.aniSets]) {
        for (const m of s.mods) {
          check(m.float0 === 0.5 && m.bytes.every(b => b === 0) && m.mtrlIndex >= -1, path, `IModData header @${m.offset}`)
          if (m.kind === 'particle') {
            for (const p of m.particles) {
              check(/\.efp$/i.test(p.path) && finite(p.position), path, `particle ${p.path}`)
              check(p.bytes[3] <= 1 && (p.extraVector !== null) === (p.bytes[3] === 1), path, 'particle extra vector')
            }
          }
          if (m.kind === 'multiTex' || m.kind === 'multiTexRev') check(/\.ddj$/i.test(m.texture), path, `multiTex ${m.texture}`)
          if (m.kind === 'bumpEnv') check(m.textures.every(t => t === null || /\.ddj$/i.test(t)), path, 'bumpEnv textures')
          if (m.kind === 'mtrl') check((m.curveKeys !== null) === ((m.flag & 4) !== 0) && m.renderStates.length === 12, path, 'mtrl')
          if (m.kind === 'sound') {
            check(m.sets.length === Math.max(0, m.setCount) && (m.config === null) === (m.setCount <= 0), path, 'sound sets')
            for (const set of m.sets) {
              // MAX_SOUND_TRACK_PER_ANI = 15 in the client.
              check(set.tracks.length <= 15, path, `sound set of ${set.tracks.length} tracks`)
              for (const t of set.tracks) if (t) check(/\.wav$/i.test(t.path) && t.keyTimeMs >= 0 && t.keyTimeMs < 60000, path, `track ${t.path}`)
            }
          }
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('resolves referenced .bms/.bmt/.bsk/.ban paths in Data.pk2', () => {
    const kinds = ['bms', 'bmt', 'bsk', 'ban'] as const
    const stats = Object.fromEntries(kinds.map(k => [k, { refs: 0, resolved: 0, unique: new Set<string>(), missing: new Map<string, string>() }]))
    const wrongExtension: string[] = []
    for (const { path, res } of parsed) {
      const refs = bsrReferencedPaths(res)
      for (const kind of kinds) {
        const s = stats[kind]!
        for (const ref of refs[kind]) {
          const key = normalizePk2Path(ref)
          if (!key.endsWith(`.${kind}`)) wrongExtension.push(`${path}: ${ref}`)
          s.refs++
          s.unique.add(key)
          if (archive.has(key)) s.resolved++
          else if (!s.missing.has(key)) s.missing.set(key, path)
        }
      }
    }
    expect(wrongExtension).toEqual([])
    for (const kind of kinds) {
      const s = stats[kind]!
      const pct = s.refs ? (100 * s.resolved) / s.refs : 100
      console.log(`  .${kind}: ${s.resolved}/${s.refs} references resolve (${pct.toFixed(2)}%), ${s.unique.size} distinct paths, ${s.missing.size} missing`)
      for (const [ref, from] of [...s.missing].slice(0, 12)) console.log(`      missing ${ref}  (from ${from})`)
    }
    // Dangling in the retail vSRO 1.188 data, not parser errors: 43 meshes of removed summer-event/festival
    // props (res/etc/...), 2 particle waterlines, 3 dungeon leftovers (piety_nike, flame prison, r2_cv test);
    // 3 .bmt (piety_boss, jinsi_floor01 dragon/statue) and the misspelled bluetiger_stnad01.ban.
    const missing = Object.fromEntries(kinds.map(k => [k, stats[k]!.missing.size]))
    expect(missing).toEqual({ bms: 48, bmt: 3, bsk: 0, ban: 1 })
    for (const kind of kinds) expect(stats[kind]!.resolved / stats[kind]!.refs).toBeGreaterThan(0.99)
    // Every mesh group / attach slot index points at a mesh of its own file.
    for (const { path, res } of parsed) {
      for (const g of res.meshGroups) {
        for (const i of g.meshIndices) if (i >= res.meshes.length) throw new Error(`${path}: mesh group index ${i}`)
      }
    }
  })

  it('has hit/footstep events and named animation types', () => {
    const eventTypes: Counter = new Map()
    const eventParams: Counter = new Map()
    const aniTypes: Counter = new Map()
    const unnamed: Counter = new Map()
    let entries = 0
    let noClip = 0
    let unsortedLists = 0
    let locomotion = 0
    for (const { res } of parsed) {
      for (const g of res.aniGroups) {
        for (const a of g.animations) {
          entries++
          inc(aniTypes, a.typeName ?? a.type)
          if (!a.typeName) inc(unnamed, a.type)
          if (a.fileIndex === -1) noClip++
          else expect(a.path).not.toBeNull()
          if (a.events.some((e, i) => e.timeMs !== a.eventsSorted[i]!.timeMs)) unsortedLists++
          if (a.walkLength !== 0) locomotion++
          for (const e of a.events) {
            inc(eventTypes, e.type)
            inc(eventParams, `type ${e.type} p1=${e.p1} p2=${e.p2}`)
          }
          expect(a.eventsSorted.map(e => e.timeMs)).toEqual(a.events.map(e => e.timeMs).sort((x, y) => x - y))
        }
      }
    }
    console.log(`  animation entries: ${entries} (${noClip} with fileIndex -1, ${locomotion} with walkLength != 0, ${unsortedLists} stored unsorted)`)
    console.log(`  event types: ${table(eventTypes)}`)
    console.log(`  event params: ${table(eventParams)}`)
    console.log(`  animation types: ${sorted(aniTypes).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${k}: ${n}`).join(', ')} ...`)
    console.log(`  types missing from the name table: ${table(unnamed) || 'none'}`)
    expect(Object.fromEntries(eventTypes)).toEqual({ 1: 16275, 2: 525, 4: 48 })
    expect({ entries, noClip, locomotion, unsortedLists }).toEqual({ entries: 17472, noClip: 2139, locomotion: 1077, unsortedLists: 0 })
    expect(unnamed.size).toBe(0)
  })

  it('walks the mod palette and attachables', () => {
    const kinds: Counter = new Map()
    const setTypes: Counter = new Map()
    const attachByType: Counter = new Map()
    const attachKinds: Counter = new Map()
    const methods: Counter = new Map()
    let tracks = 0
    let emptyTracks = 0
    let particles = 0
    for (const { res } of parsed) {
      for (const [label, sets] of [['system', res.modPalette.systemSets], ['ani', res.modPalette.aniSets]] as const) {
        for (const s of sets) {
          inc(setTypes, `${label} ${s.typeName ?? s.type}`)
          for (const m of s.mods) {
            inc(kinds, m.kind)
            if (m.kind === 'sound') {
              for (const set of m.sets) {
                for (const t of set.tracks) {
                  if (t) tracks++
                  else emptyTracks++
                }
              }
            }
            if (m.kind === 'particle') particles += m.particles.length
          }
        }
      }
      const a = res.attachable
      inc(attachByType, `${res.typeName} ${a ? (a.comboNum === null ? 'attachable' : 'attachable+combo') : 'none'}`)
      if (a) {
        inc(attachKinds, a.kind)
        inc(methods, a.attachMethodName ?? a.attachMethod)
        if (a.comboNum !== null) expect(a.comboNum).toBe(0)
        for (const s of a.slots) expect(s.meshIndex).toBeLessThan(res.meshes.length)
      }
      if (res.type === 0 || res.type === 5) expect(a).not.toBeNull()
    }
    console.log(`  mod kinds: ${table(kinds)}`)
    console.log(`  mod sets: ${table(setTypes)}; ${particles} particles, ${tracks} sound tracks (+${emptyTracks} empty slots)`)
    console.log(`  attachables: ${table(attachByType)}`)
    console.log(`  attachable kind: ${table(attachKinds)}; method: ${table(methods)}`)
    expect(Object.fromEntries(kinds)).toEqual({
      sound: 15834, particle: 1555, envMap: 1409, dyVertex: 665, mtrl: 497,
      texAni: 163, multiTex: 47, bumpEnv: 24, multiTexRev: 4,
    })
    expect(Object.fromEntries(setTypes)).toEqual({
      'ani SIMPLE': 13729, 'system LOCOMOTION': 2936, 'system AMBIENT': 2812, 'system null': 2,
    })
    expect({ particles, tracks, emptyTracks }).toEqual({ particles: 5853, tracks: 30866, emptyTracks: 858 })
    // ResAttachable: always on CHARACTER (with combo) and ITEM (without); on NPCs only when bytes remain.
    expect(Object.fromEntries(attachByType)).toEqual({
      'CHARACTER attachable+combo': 63, 'ITEM attachable': 1864, 'NPC attachable+combo': 105, 'NPC none': 504,
      'BUILDING none': 1779, 'ARTIFACT none': 322, 'NATURE none': 782, 'OTHER none': 144,
    })
  })

  it('prints readable dumps of the test assets', () => {
    const get = (path: string) => {
      const hit = parsed.find(p => p.path === path)
      if (!hit) throw new Error(`missing ${path}`)
      return hit.res
    }
    const char = get(TEST_ASSETS.character)
    const blade = get(TEST_ASSETS.weapon)
    const mob = get(TEST_ASSETS.monster)
    console.log(`\n=== ${TEST_ASSETS.character}\n${formatBsr(char, { modDetail: false })}`)
    console.log(`\n=== ${TEST_ASSETS.weapon}\n${formatBsr(blade)}`)
    console.log(`\n=== ${TEST_ASSETS.monster}\n${formatBsr(mob)}`)

    expect(char.typeName).toBe('CHARACTER')
    expect(char.skeleton?.path).toBe('prim\\skel\\char\\europe\\europeman_skel.bsk')
    expect(char.aniGroups.map(g => g.name)).toEqual(
      ['spear', 'bow', 'sword', 'default', 'cart', 'avatar_wing', 'avatar_nasrun1', 'avatar_nasrun2', 'avatar_nasrun3'])
    const cart = char.aniGroups.find(g => g.name === 'cart')!
    expect(cart.animations.map(a => [a.typeName, a.path])).toEqual([
      ['STAND1', 'prim\\ani\\char\\china\\man\\cart_stand01.ban'],
      ['WALK', 'prim\\ani\\char\\china\\man\\cart_walk.ban'],
      ['RUN', 'prim\\ani\\char\\china\\man\\cart_walk.ban'],
    ])
    const spearRun = char.aniGroups[0]!.animations.find(a => a.typeName === 'RUN')!
    expect(spearRun.walkLength).toBeCloseTo(33.3, 4)
    expect(spearRun.eventsSorted.map(e => [e.timeMs, e.type])).toEqual([[291, 2], [623, 2]])
    expect(char.attachable).toMatchObject({ kind: 0, attachPointName: 'CHAR', attachMethodName: 'BASE', comboNum: 0 })

    expect(blade.typeName).toBe('ITEM')
    expect(blade.materials).toEqual([{ id: 0, path: 'prim\\mtrl\\item\\china\\weapon\\blade1_5.bmt' }])
    expect(blade.skeleton).toEqual({ hasSkeleton: 1, path: 'prim\\skel\\item\\china\\weapon\\blade_01.bsk', attachBone: 'Bip01 R HandMid' })
    expect(blade.modPalette.systemSets[0]!.mods.map(m => m.kind)).toEqual(['envMap'])
    expect(blade.attachable).toEqual({
      kind: 1, attachPoint: 7, attachPointName: 'RIGHT_HAND', attachMethod: 2, attachMethodName: 'ADD',
      slots: [{ slot: 9, slotName: 'RIGHT_HAND', meshIndex: 0 }], comboNum: null,
    })

    expect(mob.typeName).toBe('NPC')
    expect(mob.collision.matrix).not.toBeNull()
    expect(mob.aniGroups[0]!.animations).toHaveLength(17)
    const attack = mob.aniGroups[0]!.animations.find(a => a.typeName === 'ATTACK1')!
    expect(attack.path).toBe('prim\\ani\\mob\\china\\mangnyang_attack01.ban')
    expect(attack.eventsSorted).toEqual([{ timeMs: 651, type: 1, p1: 0, p2: 0 }])
    expect(mob.modPalette.systemSets).toHaveLength(8)
    expect(mob.modPalette.aniSets).toHaveLength(7)
    expect(mob.attachable).toBeNull()
    expect(mob.materials.map(m => m.id)).toEqual([0, 2])
    const walk = mob.aniGroups[0]!.animations.find(a => a.typeName === 'WALK')!
    expect(walk.walkLength).toBeCloseTo(10.2, 4)
    expect(walk.walkGraph).toHaveLength(4)
  })

  it('reads the legacy 0108/0107 files as hexdumped', () => {
    const get = (path: string) => parsed.find(p => p.path === path)!.res
    const item = get('res/item/china/man_item/light_06_sa_h.bsr')
    expect(item.version).toBe(108)
    expect(item.collision.boundingBoxes).toHaveLength(1)
    expect(item.materials).toEqual([{ id: null, path: 'prim\\mtrl\\item\\china\\man_item\\light_06.bmt' }])
    expect(item.attachable).toEqual({
      kind: 1, attachPoint: 4, attachPointName: '_sa', attachMethod: 2, attachMethodName: 'ADD',
      slots: [{ slot: 4, slotName: 'OVERRIDE', meshIndex: 0 }], comboNum: null,
    })
    const npc = get('res/npc/npc/test.bsr')
    expect(npc.version).toBe(108)
    expect(npc.meshes).toHaveLength(3)
    expect(npc.attachable).toMatchObject({ kind: 0, attachPoint: 13, attachMethod: 0, comboNum: 0 })
    const tt = get('res/npc/npc/tt.bsr')
    expect(tt.version).toBe(107)
    expect(tt.animationPaths).toEqual([
      'prim\\ani\\npc\\china\\chinasystem_shaman_time.ban', 'prim\\ani\\npc\\china\\chinasystem_shaman_basic.ban'])
    expect(tt.aniGroups[0]!.animations.map(a => [a.typeName, a.fileIndex])).toEqual([['STAND1', 1], ['ATTREADY', 0]])
    expect(tt.modPalette.systemSets.map(s => [s.name, s.mods.map(m => m.kind)])).toEqual([
      ['ambient', ['mtrl', 'dyVertex']], ['chinasystem_shaman_time', ['particle']]])
    expect(tt.attachable!.slots.map(s => [s.slot, s.meshIndex])).toEqual([[1, 0], [2, 1], [3, 2], [11, 3], [12, 4], [13, 5]])
    expect(tt.attachable!.comboNum).toBe(0)
  })
})
