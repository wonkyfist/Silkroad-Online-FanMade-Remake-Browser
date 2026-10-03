// @sro/appearance: composition, Height/Volume formulas, starter outfits and the charCreate request.
// Synthetic data, plus the real equipment manifest when work/out/equipment/equipment.json exists.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLAYER_MODELS_CH, STARTER_OUTFITS, STARTER_WEAPONS, validateClientMessage } from '@sro/shared'
import {
  buildCharCreate,
  cameraTargetHeight,
  composeEquipment,
  composeWorn,
  EQUIPMENT_MANIFEST_VERSION,
  heightScale,
  isEquipmentManifest,
  packScaleByte,
  starterEquipment,
  starterOutfitItems,
  stepChoice,
  stepScale,
  unpackScaleByte,
  volumeBoneScales,
  volumeFactor,
  VOLUME_BONES,
  type EquipmentItem,
  type EquipmentManifest,
} from '../src/index.ts'

const JOINTS = ['Bip01', 'Bip01 Pelvis', 'Bip01 Spine']

function skinned(code: string, slot: EquipmentItem['slot'], method: 'REPLACE' | 'ADD', slots: string[], gender: 'male' | 'female' = 'male'): EquipmentItem {
  return {
    code, slot, gender, degree: 1, reqLevel: 1, name: code,
    model: { bsr: `res/${code}.bsr`, glb: `/out/equipment/${code}.glb`, sidecar: `/out/equipment/${code}.json`, kind: 'skinned', method, attachPoint: '_ba', slots: slots as never, attachBone: null, joints: JOINTS, meshes: [code.toLowerCase()] },
  }
}

function socket(code: string, slot: EquipmentItem['slot'], bone: string, twoHanded = false): EquipmentItem {
  return {
    code, slot, gender: null, degree: 1, reqLevel: 1, name: code, ...(slot === 'weapon' ? { weapon: 'SWORD', twoHanded } : {}),
    model: { bsr: `res/${code}.bsr`, glb: `/out/equipment/${code}.glb`, sidecar: `/out/equipment/${code}.json`, kind: 'socket', method: 'ADD', attachPoint: 'RIGHT_HAND', slots: ['RIGHT_HAND'], attachBone: bone, meshes: [code] },
  }
}

const BODY = { HAIR: 'hair', FACE: 'face', TORSO_UPPER: 'torso_upper', TORSO_LOWER: 'torso_lower', PELVIS: 'pelvis', THIGH: 'thigh', CALF: 'calf', ARM_UPPER: 'arm_upper', ARM_LOWER: 'arm_lower' }

const MANIFEST: EquipmentManifest = {
  version: EQUIPMENT_MANIFEST_VERSION,
  characters: [
    { code: 'CHAR_M', gender: 'male', bsr: 'm.bsr', glb: '/out/m.glb', skeleton: 'm.bsk', slots: BODY },
    { code: 'CHAR_W', gender: 'female', bsr: 'w.bsr', glb: '/out/w.glb', skeleton: 'w.bsk', slots: { ...BODY, ARM_LOWER: 'arm_fore' } },
  ],
  items: [
    skinned('ROBE', 'chest', 'REPLACE', ['TORSO_UPPER', 'TORSO_LOWER']),
    skinned('PLATE', 'chest', 'REPLACE', ['TORSO_UPPER', 'TORSO_LOWER', 'ARM_UPPER']),
    skinned('PANTS', 'legs', 'REPLACE', ['PELVIS', 'THIGH']),
    skinned('SHOES', 'feet', 'REPLACE', ['CALF']),
    skinned('GLOVES', 'hands', 'ADD', ['ARM_LOWER']),
    skinned('HELM', 'head', 'REPLACE', ['HAIR']),
    skinned('W_ROBE', 'chest', 'REPLACE', ['TORSO_UPPER', 'TORSO_LOWER'], 'female'),
    socket('SWORD', 'weapon', 'Bip01 R HandMid'),
    socket('GLAIVE', 'weapon', 'Bip01 R HandMid', true),
    socket('SHIELD', 'shield', 'Bip01 L Hand'),
  ],
}

describe('composition', () => {
  it('armour hides exactly the body parts it replaces; ADD pieces and weapons hide nothing', () => {
    const c = composeWorn(MANIFEST, 'CHAR_M', { chest: 'PLATE', legs: 'PANTS', feet: 'SHOES', hands: 'GLOVES', weapon: 'SWORD' })
    expect(c.hide.sort()).toEqual(['arm_upper', 'calf', 'pelvis', 'thigh', 'torso_lower', 'torso_upper'])
    expect(c.show.sort()).toEqual(['arm_lower', 'face', 'hair'])
    expect(c.hiddenBy.arm_upper).toEqual(['PLATE'])
    // Skinned first, then socket items.
    expect(c.bind.map(b => b.code)).toEqual(['PLATE', 'PANTS', 'GLOVES', 'SHOES', 'SWORD'])
    expect(c.bind.at(-1)).toMatchObject({ kind: 'socket', attachBone: 'Bip01 R HandMid' })
  })

  it('a robe keeps the arms; a helmet hides the hair; the face is never hidden', () => {
    const c = composeWorn(MANIFEST, 'CHAR_M', { chest: 'ROBE', head: 'HELM' })
    expect(c.hide.sort()).toEqual(['hair', 'torso_lower', 'torso_upper'])
    expect(c.show).toContain('face')
    expect(c.show).toContain('arm_upper')
  })

  it('refuses items of the other gender and a shield next to a two-handed weapon', () => {
    const c = composeWorn(MANIFEST, 'CHAR_M', { chest: 'W_ROBE', weapon: 'GLAIVE', shield: 'SHIELD' })
    expect(c.hide).toEqual([])
    expect(c.bind.map(b => b.code)).toEqual(['GLAIVE'])
    expect(c.rejected.map(r => [r.code, r.reason])).toEqual([['W_ROBE', 'gender'], ['SHIELD', 'two_handed']])
    expect(composeWorn(MANIFEST, 'CHAR_W', { chest: 'W_ROBE' }).hide.sort()).toEqual(['torso_lower', 'torso_upper'])
  })

  it('unknown codes (rings, stand-ins) are reported, not fatal; unknown characters throw', () => {
    const c = composeWorn(MANIFEST, 'CHAR_M', { ring1: 'ITEM_RING', weapon: 'SWORD' })
    expect(c.rejected).toEqual([{ code: 'ITEM_RING', reason: 'unknown', detail: 'not in the equipment manifest' }])
    expect(c.bind).toHaveLength(1)
    expect(() => composeEquipment(MANIFEST, 'CHAR_X', [])).toThrow(/unknown character/)
  })
})

describe('Height', () => {
  it('is a uniform 0.94 + 0.03 h, default 1.00, clamped', () => {
    expect([0, 1, 2, 3, 4].map(h => +heightScale(h).toFixed(4))).toEqual([0.94, 0.97, 1, 1.03, 1.06])
    expect(heightScale(undefined)).toBe(1)
    expect(heightScale(9)).toBeCloseTo(1.06)
    expect(heightScale(-3)).toBeCloseTo(0.94)
    expect(cameraTargetHeight(2)).toBeCloseTo(2)
    expect(cameraTargetHeight(4)).toBeCloseTo(2.12)
  })

  it('packs with Volume into the Scale byte (low nibble Height, default 0x22)', () => {
    expect(packScaleByte(undefined, undefined)).toBe(0x22)
    expect(packScaleByte(4, 0)).toBe(0x04)
    expect(packScaleByte(1, 3)).toBe(0x31)
    expect(unpackScaleByte(0x31)).toEqual({ height: 1, volume: 3 })
    expect(unpackScaleByte(0xff)).toEqual({ height: 2, volume: 2 })
    expect(unpackScaleByte(0x94)).toEqual({ height: 4, volume: 0 })
  })
})

describe('Volume', () => {
  it('is linear from low (v = 0) through 1 (v = 2) to high (v = 4)', () => {
    expect([0, 1, 2, 3, 4].map(v => +volumeFactor(0.88, 1.1, v).toFixed(4))).toEqual([0.88, 0.94, 1, 1.05, 1.1])
    expect(volumeFactor(0.9, 1.15, undefined)).toBe(1)
  })

  it('touches only the table bones and nothing at the default build', () => {
    expect(volumeBoneScales('male', 2).size).toBe(0)
    const thin = volumeBoneScales('male', 0)
    expect(thin.get('Bip01 Spine')).toBeCloseTo(0.88)
    expect(thin.get('Bip01 L UpperArm')).toBeCloseTo(0.92)
    expect(thin.get('Bip01 R Thigh')).toBeCloseTo(0.9)
    expect(thin.has('Bip01 Head')).toBe(false)
    // Pelvis is 1.0 at v = 4 for men, so it drops out.
    expect(volumeBoneScales('male', 4).has('Bip01 Pelvis')).toBe(false)
    const wide = volumeBoneScales('female', 4)
    expect(wide.get('Bone01')).toBeCloseTo(1.18)
    expect(wide.get('Bip01 Pelvis')).toBeCloseTo(1.08)
    expect(wide.has('Bip01 Spine1')).toBe(false)
    for (const g of ['male', 'female'] as const) for (const b of VOLUME_BONES[g]) expect(b.low < 1 && b.high >= 1).toBe(true)
  })
})

describe('starter outfits and charCreate', () => {
  it('maps Cloth to the *_DEF garment / protector / armour sets', () => {
    expect(starterOutfitItems('male', 'clothes')).toEqual({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF', legs: 'ITEM_CH_M_CLOTHES_01_LA_A_DEF', feet: 'ITEM_CH_M_CLOTHES_01_FA_A_DEF' })
    expect(starterOutfitItems('female', 'heavy').chest).toBe('ITEM_CH_W_HEAVY_01_BA_A_DEF')
    expect(starterEquipment('male', 'light', 'glaive')).toMatchObject({ chest: 'ITEM_CH_M_LIGHT_01_BA_A_DEF', weapon: 'ITEM_CH_TBLADE_01_A_DEF' })
  })

  it('every request the creation screen can send passes the protocol validator', () => {
    let n = 0
    for (const model of PLAYER_MODELS_CH) {
      for (const weapon of STARTER_WEAPONS) {
        for (const outfit of STARTER_OUTFITS) {
          for (let height = 0; height < 5; height++) {
            for (let volume = 0; volume < 5; volume++) {
              const msg = buildCharCreate({ name: ' Hero_01 ', model, weapon, height, volume, outfit })
              const r = validateClientMessage(msg)
              expect(r.ok, JSON.stringify(msg)).toBe(true)
              if (r.ok) expect(r.msg).toEqual(msg)
              n++
            }
          }
        }
      }
    }
    expect(n).toBe(26 * 5 * 3 * 25)
    // Arrow stepping never leaves the range; untouched choices send the defaults.
    let h = 2
    for (let i = 0; i < 9; i++) h = stepScale(h, 1)
    expect(h).toBe(4)
    for (let i = 0; i < 9; i++) h = stepScale(h, -1)
    expect(h).toBe(0)
    expect(stepChoice(STARTER_OUTFITS, 'clothes', -1)).toBe('heavy')
    expect(buildCharCreate({ name: 'a', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'bow' })).toMatchObject({ height: 2, volume: 2, outfit: 'clothes' })
    expect(buildCharCreate({ name: 'a', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'bow', height: 7.4, volume: -1 })).toMatchObject({ height: 4, volume: 0 })
  })
})

// The real manifest (skips without an export): every starter set composes on every Chinese model, hides exactly
// the body parts its REPLACE pieces list (always the upper torso, pelvis and calves), and the weapon is a socket item.
const REAL = join(import.meta.dirname, '../../../work/out/equipment/equipment.json')
describe.skipIf(!existsSync(REAL))('real equipment manifest', () => {
  it('dresses every Chinese model in every starter outfit and weapon', () => {
    const m = JSON.parse(readFileSync(REAL, 'utf8')) as unknown
    expect(isEquipmentManifest(m)).toBe(true)
    const manifest = m as EquipmentManifest
    for (const code of PLAYER_MODELS_CH) {
      const body = manifest.characters.find(c => c.code === code)
      if (!body) continue
      for (const outfit of STARTER_OUTFITS) {
        for (const weapon of STARTER_WEAPONS) {
          const c = composeWorn(manifest, code, starterEquipment(body.gender, outfit, weapon))
          expect(c.rejected, `${code} ${outfit} ${weapon}`).toEqual([])
          const replaced = new Set(c.bind.flatMap(b => manifest.items.find(i => i.code === b.code)!.model!).filter(mo => mo.kind === 'skinned' && mo.method === 'REPLACE').flatMap(mo => mo.slots))
          expect(c.hide.sort()).toEqual([...new Set([...replaced].map(sl => body.slots[sl]).filter(Boolean))].sort())
          for (const part of ['TORSO_UPPER', 'PELVIS', 'CALF'] as const) expect(c.hide).toContain(body.slots[part])
          expect(c.hide).not.toContain(body.slots.FACE)
          expect(c.hide).not.toContain(body.slots.HAIR)
          expect(c.bind.filter(b => b.kind === 'skinned')).toHaveLength(3)
          expect(c.bind.at(-1)).toMatchObject({ slot: 'weapon', kind: 'socket' })
        }
        if (outfit === 'heavy') expect(composeWorn(manifest, code, starterOutfitItems(body.gender, outfit)).hide).toContain(body.slots.ARM_UPPER)
      }
    }
  })
})
