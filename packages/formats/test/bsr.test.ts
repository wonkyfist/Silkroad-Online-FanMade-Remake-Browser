import { describe, expect, it } from 'vitest'
import {
  BSR_MOD_DATA_TYPE,
  bsrReferencedPaths,
  formatBsr,
  parseBsr,
  RESOURCE_ANIMATION_TYPE_NAMES,
  resourceAnimationTypeName,
  type BsrModDataBumpEnv,
  type BsrModDataEnvMap,
  type BsrModDataMtrl,
  type BsrModDataMultiTex,
  type BsrModDataParticle,
  type BsrModDataSound,
  type BsrModDataTexAni,
} from '../src/bsr.ts'

/** Little-endian byte builder for synthetic .bsr files. */
class Writer {
  private bytes: number[] = []
  private readonly view = new DataView(new ArrayBuffer(4))

  get offset(): number {
    return this.bytes.length
  }

  private push4(): this {
    for (let i = 0; i < 4; i++) this.bytes.push(this.view.getUint8(i))
    return this
  }

  u8(v: number): this {
    this.bytes.push(v & 0xff)
    return this
  }

  u16(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff)
    return this
  }

  u32(v: number): this {
    this.view.setUint32(0, v >>> 0, true)
    return this.push4()
  }

  i32(v: number): this {
    this.view.setInt32(0, v, true)
    return this.push4()
  }

  f32(v: number): this {
    this.view.setFloat32(0, v, true)
    return this.push4()
  }

  f32s(...v: number[]): this {
    for (const x of v) this.f32(x)
    return this
  }

  raw(s: string | number[]): this {
    if (typeof s === 'string') for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i))
    else this.bytes.push(...s)
    return this
  }

  str(s: string): this {
    return this.u32(s.length).raw(s)
  }

  patchU32(at: number, v: number): this {
    this.view.setUint32(0, v >>> 0, true)
    for (let i = 0; i < 4; i++) this.bytes[at + i] = this.view.getUint8(i)
    return this
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

interface Sections {
  collision: (w: Writer) => void
  material: (w: Writer) => void
  mesh: (w: Writer) => void
  animation: (w: Writer) => void
  skeleton: (w: Writer) => void
  meshGroup: (w: Writer) => void
  aniGroup: (w: Writer) => void
  palette: (w: Writer) => void
  tail?: (w: Writer) => void
}

/** Build a file in the client's section order, patching the header offsets. */
function buildBsr(version: string, type: number, name: string, primMeshFlag: number, s: Sections): Uint8Array {
  const w = new Writer().raw(`JMXVRES ${version}`)
  const headerAt = w.offset
  for (let i = 0; i < 13; i++) w.u32(0)
  w.patchU32(headerAt + 32, primMeshFlag)
  w.u16(type).u16(2).str(name).u32(7).u32(1)
  w.raw(new Array<number>(40).fill(0))
  // Header slots: 0 material, 1 mesh, 2 skeleton, 3 animation, 4 meshGroup, 5 aniGroup, 6 palette, 7 collision.
  const order: Array<[number, (w: Writer) => void]> = [
    [7, s.collision], [0, s.material], [1, s.mesh], [3, s.animation],
    [2, s.skeleton], [4, s.meshGroup], [5, s.aniGroup], [6, s.palette],
  ]
  for (const [slot, write] of order) {
    w.patchU32(headerAt + slot * 4, w.offset)
    write(w)
  }
  s.tail?.(w)
  return w.done()
}

function modBase(w: Writer, tag: number, mtrlIndex = -1, int1 = 0): Writer {
  return w.u32(tag).f32(0.5).i32(1).i32(int1).i32(mtrlIndex).i32(0).i32(0).raw([0, 0, 0, 0])
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function character0109(): Uint8Array {
  return buildBsr('0109', 0, 'test_char', 1, {
    collision: w => {
      w.str('prim\\mesh\\col.bms').f32s(-1, -2, -3, 1, 2, 3).f32s(-4, -5, -6, 4, 5, 6).u32(1).f32s(...IDENTITY)
    },
    material: w => w.u32(2).u32(0).str('prim\\mtrl\\a.bmt').u32(3).str('prim\\mtrl\\b.bmt'),
    mesh: w => w.u32(2).str('prim\\mesh\\a.bms').u32(1).str('prim\\mesh\\b.bms').u32(0),
    animation: w => w.u32(0x1000).u32(0).u32(2).str('prim\\ani\\stand.ban').str('prim\\ani\\run.ban'),
    skeleton: w => w.u32(1).str('prim\\skel\\a.bsk').str('Bip01 R Hand'),
    meshGroup: w => w.u32(1).str('default').u32(2).u32(0).u32(1),
    aniGroup: w => {
      w.u32(1).str('default').u32(3)
      // RUN -> run.ban, events stored out of order
      w.u32(7).i32(1).u32(2)
      w.u32(500).u32(1).i32(1).i32(0)
      w.u32(100).u32(2).i32(0).i32(1)
      w.u32(2).f32(33.25).f32s(0, 0, 1, 1)
      // SKILL_4 with no clip
      w.u32(0x1d).i32(-1).u32(0).u32(2).f32(0).f32s(0, 0, 1, 1)
      // a type missing from the name table
      w.u32(0x2d).i32(0).u32(0).u32(0).f32(0)
    },
    palette: w => {
      w.u32(1) // system sets
      w.u32(2).i32(-1).str('ambient').u32(3)
      modBase(w, BSR_MOD_DATA_TYPE.envMap, -1, 0x300).u32(1).u32(0x30000).u32(0).u32(0x7c000000)
      modBase(w, BSR_MOD_DATA_TYPE.particle, -1, 0x30).u32(2)
      w.u32(1).str('fx\\a.efp').str('').f32s(0, 16, -0.5).u32(0).raw([0, 1, 0, 0])
      w.u32(0).str('fx\\b.efp').str('Bone09').f32s(1, 2, 3).u32(250).raw([0, 0, 0, 1]).f32s(7, 8, 9)
      modBase(w, BSR_MOD_DATA_TYPE.mtrl, 2).u32(1000).u32(6).u32(9).u32(2)
      w.u32(0).f32s(0.5, 0.5, 0.5, 1).u32(1000).f32s(1, 1, 1, 1)
      w.u32(1).u32(500).f32(0.25)
      w.u32(0).u32(1).u32(0).u32(0).raw([5, 6, 4, 0, 2, 4, 0, 2, 0x80, 7, 100, 200]).f32(1).u32(1)
      w.u32(1) // ani sets
      w.u32(1).i32(7).str('default').u32(5)
      modBase(w, BSR_MOD_DATA_TYPE.sound, -1, 0x10).i32(1)
      w.u32(0x90).i32(3).i32(0).f32(10).f32(100).i32(0).i32(0).i32(0).i32(0).i32(0).i32(0)
      w.str('default').u32(2).u32(1).str('prim\\snd\\run.wav').i32(290).str('snd_run1').u32(0)
      modBase(w, BSR_MOD_DATA_TYPE.texAni, 0, 0x110).u32(1).u32(1).u32(10).u32(1).u32(1)
      w.f32s(1, 0, 0, 0, 0, 1, 0, 0, 0.25, -1.5, 1, 0, 0, 0, 0, 1)
      modBase(w, BSR_MOD_DATA_TYPE.multiTexRev, 0, 0x100).u32(4).str('prim\\mtrl\\flip.ddj').u32(5)
      modBase(w, BSR_MOD_DATA_TYPE.bumpEnv).u32(1).u32(2).u32(3).u32(4).f32s(1, 2, 3, 4, 5, 6).u32(2)
      w.u8(0).u8(1).str('prim\\mtrl\\bump.ddj')
      modBase(w, BSR_MOD_DATA_TYPE.dyVertex, 3)
    },
    tail: w => w.i32(0).i32(13).u32(0).u32(2).u32(1).u32(0).u32(2).u32(1).u32(0),
  })
}

describe('parseBsr 0109', () => {
  const res = parseBsr(character0109())

  it('reads the header, object info and collision', () => {
    expect(res.signature).toBe('JMXVRES 0109')
    expect(res.version).toBe(109)
    expect(res.header.primMeshFlag).toBe(1)
    expect(res.header.modDataFlag).toBe(0)
    expect(res.header.reserved).toEqual([0, 0, 0])
    expect(res.header.collisionOffset).toBeLessThan(res.header.materialOffset)
    expect(res.type).toBe(0)
    expect(res.typeName).toBe('CHARACTER')
    expect(res.category).toBe(2)
    expect(res.categoryName).toBe('RESOURCE')
    expect(res.name).toBe('test_char')
    expect(res.objectInfoUnknown).toEqual([7, 1])
    expect(res.reserved).toHaveLength(40)
    expect(res.collision.meshPath).toBe('prim\\mesh\\col.bms')
    expect(res.collision.boundingBoxes).toEqual([
      { min: [-1, -2, -3], max: [1, 2, 3] },
      { min: [-4, -5, -6], max: [4, 5, 6] },
    ])
    expect(res.collision.hasMatrix).toBe(1)
    expect(res.collision.matrix).toEqual(IDENTITY)
  })

  it('reads materials, meshes, skeleton and groups', () => {
    expect(res.materials).toEqual([
      { id: 0, path: 'prim\\mtrl\\a.bmt' },
      { id: 3, path: 'prim\\mtrl\\b.bmt' },
    ])
    expect(res.meshes).toEqual([
      { path: 'prim\\mesh\\a.bms', flag: 1 },
      { path: 'prim\\mesh\\b.bms', flag: 0 },
    ])
    expect(res.animationTypeVersion).toBe(0x1000)
    expect(res.animationPaths).toEqual(['prim\\ani\\stand.ban', 'prim\\ani\\run.ban'])
    expect(res.legacyTimelines).toBeNull()
    expect(res.skeleton).toEqual({ hasSkeleton: 1, path: 'prim\\skel\\a.bsk', attachBone: 'Bip01 R Hand' })
    expect(res.meshGroups).toEqual([{ name: 'default', meshIndices: [0, 1] }])
  })

  it('reads animation entries with raw and time-sorted events', () => {
    expect(res.aniGroups).toHaveLength(1)
    const [run, skill, unnamed] = res.aniGroups[0]!.animations
    expect(run!.type).toBe(7)
    expect(run!.typeName).toBe('RUN')
    expect(run!.fileIndex).toBe(1)
    expect(run!.path).toBe('prim\\ani\\run.ban')
    expect(run!.events.map(e => e.timeMs)).toEqual([500, 100])
    expect(run!.eventsSorted).toEqual([
      { timeMs: 100, type: 2, p1: 0, p2: 1 },
      { timeMs: 500, type: 1, p1: 1, p2: 0 },
    ])
    expect(run!.walkLength).toBeCloseTo(33.25)
    expect(run!.walkGraph).toEqual([[0, 0], [1, 1]])
    expect(skill!.typeName).toBe('SKILL_4')
    expect(skill!.fileIndex).toBe(-1)
    expect(skill!.path).toBeNull()
    expect(unnamed!.typeName).toBeUndefined()
    expect(unnamed!.path).toBe('prim\\ani\\stand.ban')
    expect(unnamed!.walkGraph).toEqual([])
  })

  it('walks every ModData payload', () => {
    const [ambient] = res.modPalette.systemSets
    expect(ambient!.type).toBe(2)
    expect(ambient!.typeName).toBe('AMBIENT')
    expect(ambient!.animationType).toBe(-1)
    expect(ambient!.name).toBe('ambient')
    const [env, part, mtrl] = ambient!.mods
    expect(env!.kind).toBe('envMap')
    expect((env as BsrModDataEnvMap).unknown).toEqual([1, 0x30000, 0, 0x7c000000])
    expect(env!.int1).toBe(0x300)
    expect(env!.mtrlIndex).toBe(-1)
    expect(env!.float0).toBe(0.5)
    const particles = (part as BsrModDataParticle).particles
    expect(particles).toHaveLength(2)
    expect(particles[0]).toMatchObject({ flag: 1, path: 'fx\\a.efp', bone: '', position: [0, 16, -0.5], bytes: [0, 1, 0, 0], extraVector: null })
    expect(particles[1]).toMatchObject({ flag: 0, bone: 'Bone09', birthTimeMs: 250, extraVector: [7, 8, 9] })
    const m = mtrl as BsrModDataMtrl
    expect(m.kind).toBe('mtrl')
    expect(m.mtrlIndex).toBe(2)
    expect(m.durationMs).toBe(1000)
    expect(m.flag).toBe(6)
    expect(m.gradientKeys).toEqual([
      { timeMs: 0, color: [0.5, 0.5, 0.5, 1] },
      { timeMs: 1000, color: [1, 1, 1, 1] },
    ])
    expect(m.curveKeys).toEqual([{ timeMs: 500, value: 0.25 }])
    expect(m.renderStates).toEqual([5, 6, 4, 0, 2, 4, 0, 2, 0x80, 7, 100, 200])
    expect(m.unknownFloat).toBe(1)
    expect(m.unknown2).toBe(1)

    const [walkSet] = res.modPalette.aniSets
    expect(walkSet!.typeName).toBe('SIMPLE')
    expect(walkSet!.animationTypeName).toBe('RUN')
    const [snd, tex, flip, bump, dy] = walkSet!.mods
    const sound = snd as BsrModDataSound
    expect(sound.setCount).toBe(1)
    expect(sound.config).toMatchObject({ flags: 0x90, int6: 3, float0: 10, float1: 100 })
    expect(sound.sets).toEqual([
      { name: 'default', tracks: [{ path: 'prim\\snd\\run.wav', keyTimeMs: 290, event: 'snd_run1' }, null] },
    ])
    const texAni = tex as BsrModDataTexAni
    expect(texAni.unknown).toEqual([1, 1, 10, 1, 1])
    expect(texAni.matrix[8]).toBe(0.25)
    expect(texAni.matrix[9]).toBe(-1.5)
    const multi = flip as BsrModDataMultiTex
    expect(multi.kind).toBe('multiTexRev')
    expect(multi).toMatchObject({ unknown0: 4, texture: 'prim\\mtrl\\flip.ddj', unknown1: 5 })
    const b = bump as BsrModDataBumpEnv
    expect(b.unknown).toEqual([1, 2, 3, 4])
    expect(b.floats).toEqual([1, 2, 3, 4, 5, 6])
    expect(b.textures).toEqual([null, 'prim\\mtrl\\bump.ddj'])
    expect(dy!.kind).toBe('dyVertex')
    expect(dy!.mtrlIndex).toBe(3)
  })

  it('reads the character attachable with its combo count and consumes the file', () => {
    expect(res.attachable).toEqual({
      kind: 0,
      attachPoint: 13,
      attachPointName: 'CHAR',
      attachMethod: 0,
      attachMethodName: 'BASE',
      slots: [
        { slot: 1, slotName: 'FACE', meshIndex: 0 },
        { slot: 2, slotName: 'TORSO_UPPER', meshIndex: 1 },
      ],
      comboNum: 0,
    })
    expect(res.trailing).toHaveLength(0)
  })

  it('lists referenced paths and formats a dump', () => {
    expect(bsrReferencedPaths(res)).toEqual({
      bms: ['prim\\mesh\\a.bms', 'prim\\mesh\\b.bms', 'prim\\mesh\\col.bms'],
      bmt: ['prim\\mtrl\\a.bmt', 'prim\\mtrl\\b.bmt'],
      bsk: ['prim\\skel\\a.bsk'],
      ban: ['prim\\ani\\stand.ban', 'prim\\ani\\run.ban'],
    })
    const dump = formatBsr(res)
    expect(dump).toContain("aniGroup 'default' (3 entries)")
    expect(dump).toContain('RUN(7) -> prim\\ani\\run.ban')
    expect(dump).toContain('events: 100ms type=2 p=(0,1); 500ms type=1 p=(1,0)')
    expect(dump).toContain('snd[default] 290ms prim\\snd\\run.wav')
    expect(formatBsr(res, { modDetail: false })).toContain("'ambient' (3 mods): envMap, particle, mtrl")
  })
})

function simple0109(type: number, tail?: (w: Writer) => void): Uint8Array {
  return buildBsr('0109', type, 'simple', 0, {
    collision: w => w.str('').f32s(0, 0, 0, 1, 1, 1).f32s(0, 0, 0, 1, 1, 1).u32(0),
    material: w => w.u32(1).u32(0).str('m.bmt'),
    mesh: w => w.u32(1).str('m.bms'),
    animation: w => w.u32(0x1000).u32(0).u32(0),
    skeleton: w => w.u32(0),
    meshGroup: w => w.u32(1).str('default').u32(1).u32(0),
    aniGroup: w => w.u32(0),
    palette: w => w.u32(0).u32(0),
    ...(tail ? { tail } : {}),
  })
}

describe('parseBsr attachable rules', () => {
  it('reads an item attachable without a combo count', () => {
    const res = parseBsr(simple0109(5, w => w.i32(1).i32(7).u32(2).u32(1).u32(9).u32(0)))
    expect(res.skeleton).toBeNull()
    expect(res.meshes).toEqual([{ path: 'm.bms', flag: null }])
    expect(res.attachable).toMatchObject({ kind: 1, attachPointName: 'RIGHT_HAND', attachMethodName: 'ADD', comboNum: null })
    expect(res.attachable!.slots).toEqual([{ slot: 9, slotName: 'RIGHT_HAND', meshIndex: 0 }])
    expect(res.trailing).toHaveLength(0)
  })

  it('treats the attachable as optional for NPCs and buildings', () => {
    expect(parseBsr(simple0109(1)).attachable).toBeNull()
    expect(parseBsr(simple0109(2)).attachable).toBeNull()
    const npc = parseBsr(simple0109(1, w => w.i32(0).i32(13).u32(0).u32(0).u32(0)))
    expect(npc.attachable).toMatchObject({ kind: 0, attachPoint: 13, slots: [], comboNum: 0 })
  })

  it('requires the attachable for characters and items', () => {
    expect(() => parseBsr(simple0109(5))).toThrow(/^BSR: .*offset \d+/)
    expect(() => parseBsr(simple0109(0))).toThrow(/^BSR: /)
  })
})

describe('parseBsr legacy layouts', () => {
  it('reads 0108: one bounding box and a single material path', () => {
    const bytes = buildBsr('0108', 1, 'npc_0108', 0, {
      collision: w => w.str('').f32s(-1, 0, -1, 1, 2, 1).u32(0),
      material: w => w.str('prim\\mtrl\\npc.bmt'),
      mesh: w => w.u32(1).str('prim\\mesh\\npc.bms'),
      animation: w => w.u32(0x1000).u32(0).u32(1).str('prim\\ani\\npc.ban'),
      skeleton: w => w.u32(1).str('prim\\skel\\npc.bsk').str(''),
      meshGroup: w => w.u32(1).str('default').u32(1).u32(0),
      aniGroup: w => w.u32(1).str('default').u32(1).u32(0).i32(0).u32(0).u32(2).f32(0).f32s(0, 0, 1, 1),
      palette: w => w.u32(0).u32(0),
      tail: w => w.i32(0).i32(13).u32(0).u32(1).u32(0).u32(0).u32(0),
    })
    const res = parseBsr(bytes)
    expect(res.version).toBe(108)
    expect(res.collision.boundingBoxes).toEqual([{ min: [-1, 0, -1], max: [1, 2, 1] }])
    expect(res.materials).toEqual([{ id: null, path: 'prim\\mtrl\\npc.bmt' }])
    expect(res.aniGroups[0]!.animations[0]).toMatchObject({ typeName: 'STAND1', path: 'prim\\ani\\npc.ban' })
    expect(res.attachable).toMatchObject({ attachPoint: 13, comboNum: 0 })
    expect(res.trailing).toHaveLength(0)
  })

  it('reads 0107: per-file timelines, bare group entries and untyped mod sets', () => {
    const bytes = buildBsr('0107', 1, 'npc_0107', 0, {
      collision: w => w.str('').f32s(0, 0, 0, 1, 1, 1).u32(0),
      material: w => w.str('prim\\mtrl\\old.bmt'),
      mesh: w => w.u32(1).str('prim\\mesh\\old.bms'),
      animation: w => {
        w.u32(0x1000).u32(0).u32(2)
        w.str('prim\\ani\\time.ban').u32(1).u32(900).u32(1).i32(0).i32(0).u32(2).f32(0).f32s(0, 0, 1, 1)
        w.str('prim\\ani\\basic.ban').u32(0).u32(2).f32(0).f32s(0, 0, 1, 1)
      },
      skeleton: w => w.u32(1).str('prim\\skel\\old.bsk').str(''),
      meshGroup: w => w.u32(1).str('default').u32(1).u32(0),
      aniGroup: w => w.u32(1).str('default').u32(2).u32(0).i32(1).u32(6).i32(0),
      palette: w => {
        w.u32(1).str('ambient').u32(1)
        modBase(w, BSR_MOD_DATA_TYPE.dyVertex)
      },
      tail: w => w.i32(0).i32(13).u32(0).u32(1).u32(1).u32(0).u32(0),
    })
    const res = parseBsr(bytes)
    expect(res.version).toBe(107)
    expect(res.legacyTimelines).toHaveLength(2)
    expect(res.legacyTimelines![0]!.events).toEqual([{ timeMs: 900, type: 1, p1: 0, p2: 0 }])
    const [stand, ready] = res.aniGroups[0]!.animations
    expect(stand).toMatchObject({ type: 0, fileIndex: 1, path: 'prim\\ani\\basic.ban', events: [] })
    expect(ready).toMatchObject({ type: 6, typeName: 'ATTREADY', path: 'prim\\ani\\time.ban' })
    expect(ready!.eventsSorted).toEqual([{ timeMs: 900, type: 1, p1: 0, p2: 0 }])
    expect(res.modPalette.systemSets).toEqual([
      expect.objectContaining({ type: null, animationType: null, name: 'ambient' }),
    ])
    expect(res.modPalette.systemSets[0]!.mods[0]!.kind).toBe('dyVertex')
    expect(res.modPalette.aniSets).toEqual([])
    expect(res.attachable).toMatchObject({ slots: [{ slot: 1, slotName: 'FACE', meshIndex: 0 }], comboNum: 0 })
    expect(res.trailing).toHaveLength(0)
  })
})

describe('parseBsr errors', () => {
  it('rejects bad signatures and unknown versions', () => {
    const bytes = character0109()
    const other = bytes.slice()
    other.set([0x30, 0x31, 0x31, 0x30], 8) // "0110"
    expect(() => parseBsr(other)).toThrow(/unsupported version/)
    const bad = bytes.slice()
    bad[0] = 0x58
    expect(() => parseBsr(bad)).toThrow(/bad signature/)
    expect(() => parseBsr(new Uint8Array(10))).toThrow(/too short/)
  })

  it('names the offset of a truncation', () => {
    const bytes = character0109()
    for (const cut of [70, 200, bytes.length - 3]) {
      expect(() => parseBsr(bytes.subarray(0, cut))).toThrow(/^BSR: .*offset \d+/)
    }
  })

  it('rejects unknown ModData tags', () => {
    const bytes = simple0109(2)
    // replace the empty palette with one set holding tag 0x00020000
    const w = new Writer().raw(Array.from(bytes.subarray(0, bytes.length - 8)))
    w.u32(1).u32(2).i32(-1).str('ambient').u32(1)
    const tagAt = w.offset
    modBase(w, 0x00020000).u32(0)
    expect(() => parseBsr(w.done())).toThrow(`BSR: unknown ModData tag 0x00020000 at offset ${tagAt}`)
  })

  it('rejects a section that does not end where the next one starts', () => {
    // One stray word after the collision matrix flag: the parse would otherwise silently skip it.
    const stray = buildBsr('0109', 2, 'stray', 0, {
      collision: w => w.str('').f32s(0, 0, 0, 1, 1, 1).f32s(0, 0, 0, 1, 1, 1).u32(0).u32(0),
      material: w => w.u32(1).u32(0).str('m.bmt'),
      mesh: w => w.u32(1).str('m.bms'),
      animation: w => w.u32(0x1000).u32(0).u32(0),
      skeleton: w => w.u32(0),
      meshGroup: w => w.u32(0),
      aniGroup: w => w.u32(0),
      palette: w => w.u32(0).u32(0),
    })
    expect(() => parseBsr(stray)).toThrow(/^BSR: collision section ends at \d+ but the next section starts at \d+ at offset \d+$/)
    // An extra padding word at the end of the mesh section.
    const padded = buildBsr('0109', 2, 'padded', 0, {
      collision: w => w.str('').f32s(0, 0, 0, 1, 1, 1).f32s(0, 0, 0, 1, 1, 1).u32(0),
      material: w => w.u32(1).u32(0).str('m.bmt'),
      mesh: w => w.u32(1).str('m.bms').u32(0),
      animation: w => w.u32(0x1000).u32(0).u32(0),
      skeleton: w => w.u32(0),
      meshGroup: w => w.u32(0),
      aniGroup: w => w.u32(0),
      palette: w => w.u32(0).u32(0),
    })
    expect(() => parseBsr(padded)).toThrow(/^BSR: mesh section ends at/)
  })

  it('requires a four-digit version', () => {
    const bytes = simple0109(2).slice()
    bytes.set([0x31, 0x30, 0x39, 0x78], 8) // "109x"
    expect(() => parseBsr(bytes)).toThrow(/unsupported version/)
  })

  it('rejects impossible counts', () => {
    const bytes = simple0109(2).slice()
    const view = new DataView(bytes.buffer)
    const meshOffset = view.getUint32(16, true)
    view.setUint32(meshOffset, 0x10000000, true)
    expect(() => parseBsr(bytes)).toThrow(`BSR: mesh count 268435456 cannot fit`)
  })
})

describe('ResourceAnimationType names', () => {
  it('covers the SilkroadDoc enum', () => {
    expect(resourceAnimationTypeName(0x00)).toBe('STAND1')
    expect(resourceAnimationTypeName(0x7a)).toBe('STAND2')
    expect(resourceAnimationTypeName(0x07)).toBe('RUN')
    expect(resourceAnimationTypeName(0x1a)).toBe('SKILL_1')
    expect(resourceAnimationTypeName(0x23)).toBe('SKILL_10')
    expect(resourceAnimationTypeName(0x44)).toBe('SKILL_11')
    expect(resourceAnimationTypeName(0x65)).toBe('SKILL_21')
    expect(resourceAnimationTypeName(0x78)).toBe('SKILL_40')
    expect(resourceAnimationTypeName(0x7b)).toBe('SKILL_41')
    expect(resourceAnimationTypeName(0xb6)).toBe('SKILL_100')
    expect(resourceAnimationTypeName(0x32)).toBe('EMOTION01')
    expect(resourceAnimationTypeName(0x3b)).toBe('EMOTION10')
    expect(resourceAnimationTypeName(0xc6)).toBe('ATTACK16')
    expect(resourceAnimationTypeName(0xbf)).toBe('SHOT')
    expect(resourceAnimationTypeName(0x2d)).toBeUndefined()
    // 179 SilkroadDoc names + OBSOLETE_STAND2
    expect(Object.keys(RESOURCE_ANIMATION_TYPE_NAMES)).toHaveLength(180)
    expect(new Set(Object.values(RESOURCE_ANIMATION_TYPE_NAMES)).size).toBe(180)
  })
})
