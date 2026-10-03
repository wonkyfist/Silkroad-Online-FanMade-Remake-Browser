// Pure tests of the equipment composition rules and the coverage metrics (synthetic data, no client needed).
import { describe, expect, it } from 'vitest'
import { composeEquipment, indexManifest, missingJoints } from '../src/equipment/compose.ts'
import { gapReport, pokeReport, triangles, type MeshGeometry } from '../src/equipment/coverage.ts'
import { EQUIPMENT_MANIFEST_VERSION, isEquipmentManifest, type EquipmentItem, type EquipmentManifest } from '../src/equipment/manifest.ts'

const JOINTS = ['Bip01', 'Bip01 Pelvis', 'Bip01 Spine', 'Bip01 L Hand', 'Bip01 R HandMid']

function skinned(code: string, slot: EquipmentItem['slot'], method: 'REPLACE' | 'ADD', slots: string[], gender: 'male' | 'female' = 'male'): EquipmentItem {
  return {
    code, slot, gender, degree: 1, reqLevel: 1, name: code,
    model: { bsr: `res/${code}.bsr`, glb: `/out/equipment/${code}.glb`, sidecar: `/out/equipment/${code}.json`, kind: 'skinned', method, attachPoint: '_ba', slots: slots as never, attachBone: null, joints: JOINTS, meshes: [code.toLowerCase()] },
  }
}

function socket(code: string, slot: EquipmentItem['slot'], bone: string, twoHanded = false): EquipmentItem {
  return {
    code, slot, gender: null, degree: 1, reqLevel: 1, name: code, ...(slot === 'weapon' ? { weapon: 'SWORD', twoHanded } : {}),
    model: { bsr: `res/${code}.bsr`, glb: `/out/equipment/${code}.glb`, sidecar: `/out/equipment/${code}.json`, kind: 'socket', method: 'ADD', attachPoint: 'LEFT_HAND', slots: ['LEFT_HAND'], attachBone: bone, meshes: [code] },
  }
}

const MANIFEST: EquipmentManifest = {
  version: EQUIPMENT_MANIFEST_VERSION,
  generator: 'test',
  provenance: 'synthetic',
  rules: [],
  characters: [
    {
      code: 'CHAR_M', gender: 'male', bsr: 'm.bsr', glb: '/out/m.glb', skeleton: 'm.bsk',
      slots: { HAIR: 'hair', FACE: 'face', TORSO_UPPER: 'torso_upper', TORSO_LOWER: 'torso_lower', PELVIS: 'pelvis', THIGH: 'thigh', CALF: 'calf', ARM_UPPER: 'arm_upper', ARM_LOWER: 'arm_lower' },
    },
  ],
  items: [
    skinned('SHIRT', 'chest', 'REPLACE', ['TORSO_UPPER', 'TORSO_LOWER']),
    skinned('PLATE', 'chest', 'REPLACE', ['TORSO_UPPER', 'TORSO_LOWER', 'ARM_UPPER']),
    skinned('PANTS', 'legs', 'REPLACE', ['PELVIS', 'THIGH']),
    skinned('BOOTS', 'feet', 'REPLACE', ['CALF']),
    skinned('GLOVES', 'hands', 'ADD', ['ARM_LOWER']),
    skinned('PADS', 'shoulders', 'ADD', ['OVERRIDE']),
    skinned('HELM', 'head', 'REPLACE', ['HAIR']),
    skinned('SKIRT', 'legs', 'REPLACE', ['PELVIS'], 'female'),
    { code: 'CROWN', slot: 'head', gender: 'male', degree: 1, reqLevel: 1, name: 'crown', model: null },
    socket('SHIELD', 'shield', 'Bip01 L Hand'),
    socket('SWORD', 'weapon', 'Bip01 R HandMid'),
    socket('SPEAR', 'weapon', 'Bip01 R HandMid', true),
  ],
}

describe('composeEquipment', () => {
  it('shows every base mesh when nothing is worn', () => {
    const c = composeEquipment(MANIFEST, 'CHAR_M', [])
    expect(c.hide).toEqual([])
    expect(c.show).toHaveLength(9)
    expect(c.bind).toEqual([])
  })

  it('REPLACE hides exactly the listed slots, ADD hides nothing', () => {
    const c = composeEquipment(MANIFEST, 'CHAR_M', ['SHIRT', 'PANTS', 'BOOTS', 'GLOVES', 'PADS'])
    expect(c.hide.sort()).toEqual(['calf', 'pelvis', 'thigh', 'torso_lower', 'torso_upper'])
    expect(c.show.sort()).toEqual(['arm_lower', 'arm_upper', 'face', 'hair'])
    expect(c.hiddenBy.torso_upper).toEqual(['SHIRT'])
    expect(c.bind.map(b => b.code)).toEqual(['SHIRT', 'PANTS', 'BOOTS', 'GLOVES', 'PADS'])
    expect(c.bind.every(b => b.kind === 'skinned' && b.joints.length === JOINTS.length)).toBe(true)
  })

  it('a helmet hides the hair; a model-less crown keeps it', () => {
    expect(composeEquipment(MANIFEST, 'CHAR_M', ['HELM']).hide).toEqual(['hair'])
    const crown = composeEquipment(MANIFEST, 'CHAR_M', ['CROWN'])
    expect(crown.hide).toEqual([])
    expect(crown.invisible).toEqual(['CROWN'])
    expect(crown.bind).toEqual([])
  })

  it('one item per slot: the later code wins', () => {
    const c = composeEquipment(MANIFEST, 'CHAR_M', ['SHIRT', 'PLATE'])
    expect(c.bind.map(b => b.code)).toEqual(['PLATE'])
    expect(c.hide.sort()).toEqual(['arm_upper', 'torso_lower', 'torso_upper'])
    expect(c.rejected).toEqual([{ code: 'SHIRT', reason: 'slot_taken', detail: 'chest is taken by PLATE' }])
  })

  it('refuses the other gender, unknown codes and a shield with a two-handed weapon', () => {
    const c = composeEquipment(indexManifest(MANIFEST), 'CHAR_M', ['SKIRT', 'NOPE', 'SPEAR', 'SHIELD'])
    expect(c.rejected.map(r => [r.code, r.reason])).toEqual([['SKIRT', 'gender'], ['NOPE', 'unknown'], ['SHIELD', 'two_handed']])
    expect(c.bind.map(b => b.code)).toEqual(['SPEAR'])
    const ok = composeEquipment(MANIFEST, 'CHAR_M', ['SHIELD', 'SWORD', 'SHIRT'])
    expect(ok.bind.map(b => [b.code, b.kind, b.attachBone])).toEqual([
      ['SHIRT', 'skinned', null], ['SHIELD', 'socket', 'Bip01 L Hand'], ['SWORD', 'socket', 'Bip01 R HandMid'],
    ])
  })

  it('throws for an unknown character', () => {
    expect(() => composeEquipment(MANIFEST, 'CHAR_X', [])).toThrow(/unknown character/)
  })

  it('checks joints by name', () => {
    expect(missingJoints(JOINTS, JOINTS)).toEqual([])
    expect(missingJoints(['Bip01', 'Bip01 Neck'], JOINTS)).toEqual(['Bip01 Neck'])
    expect(isEquipmentManifest(MANIFEST)).toBe(true)
    expect(isEquipmentManifest({ version: 0 })).toBe(false)
  })
})

/** Axis-aligned box (outward normals, counter-clockwise faces), 8 shared corners, with vertex normals. */
function box(name: string, min: number[], max: number[]): MeshGeometry {
  const p: number[] = []
  const n: number[] = []
  const idx: number[] = []
  const faces: Array<[number, number[][]]> = [
    [0, [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]], [0, [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [1, [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]], [1, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [2, [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]], [2, [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ]
  for (const [axis, quad] of faces) {
    const base = p.length / 3
    const normal = [0, 0, 0]
    normal[axis] = quad[0]![axis]! === 1 ? 1 : -1
    for (const c of quad) {
      p.push(...c.map((v, k) => (v ? max[k]! : min[k]!)))
      n.push(...normal)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return { name, positions: p, normals: n, indices: idx }
}

describe('coverage metrics', () => {
  const body = box('body', [-0.1, 0.5, -0.1], [0.1, 1, 0.1])
  it('a slightly larger shell covers the body; nothing leaves a gap', () => {
    const shell = box('shell', [-0.12, 0.48, -0.12], [0.12, 1.02, 0.12])
    const r = gapReport(body, triangles([shell]))
    expect(r.gaps).toBe(0)
    expect(r.maxOffset).toBeCloseTo(0.02, 5)
    expect(gapReport(body, triangles([])).gaps).toBe(r.checked)
  })
  it('a body vertex just outside the item is poke-through; one inside is under it', () => {
    const shell = box('shell', [-0.09, 0.4, -0.09], [0.09, 1.1, 0.09])
    const r = pokeReport(box('arm', [-0.095, 0.7, -0.05], [0.095, 0.8, 0.05]), triangles([shell]))
    expect(r.poke).toBe(24)
    expect(pokeReport(box('arm', [-0.05, 0.7, -0.05], [0.05, 0.8, 0.05]), triangles([shell])).under).toBe(24)
  })
})
