import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { heightScale } from '@sro/appearance'
import { LOOK_BUILD_DEFAULT, LOOK_HAIRS, LOOK_MAKEUPS, LOOK_SKIN_TONES, defaultLook, lookOutfitAccessories, lookSkinMultiplier, parseLook, type CharacterSummary } from '@sro/shared'
import {
  BUILD_LIMITS,
  hairPartNames,
  localBoneScales,
  lookBoneTargets,
  lookMaterialPlan,
  lookPartNames,
  lookPartOf,
  lookSlotOf,
  partBaseName,
  slotKey,
} from '../src/three/licensed-look.ts'
import { createMessage, edit, editCreator, hairOf, lookMessage, newCreator, offersCreator } from '../src/screens/creator-model.ts'

describe('the look catalogue (§16.10)', () => {
  it('offers the pack: 45 / 17 makeups, 3 styles × bangs, a natural skin range, outfit accessories', () => {
    expect(LOOK_MAKEUPS.f).toHaveLength(45)
    expect(LOOK_MAKEUPS.m).toHaveLength(17)
    for (const b of ['f', 'm'] as const) {
      const combos = new Set(Object.values(LOOK_HAIRS[b]).map(h => `${h.style}${h.bangs}`))
      expect(combos.size).toBe(6)
    }
    // natural skin: warm (r ≥ g ≥ b), never brighter than 4 % over the pack, the shift ±8 %
    for (const t of LOOK_SKIN_TONES) expect(t[0] >= t[1] && t[1] >= t[2] && t[0] <= 1.04).toBe(true)
    expect(lookSkinMultiplier(0, 50)[0]).toBeCloseTo(1.08)
    expect(lookOutfitAccessories('f', '03')).toEqual(['earrings', 'hair_flower'])
    expect(defaultLook('f', 0).accessories).toContain('earrings')
    expect(defaultLook('m', 0).accessories).toEqual([])
  })
})

describe('drawing a look (three/licensed-look.ts)', () => {
  it('names the hair pieces and accessories, by part (any LOD, primitive or soft pass)', () => {
    expect(hairPartNames('f', '04')).toEqual(['SK_RIVERSPIRIT_F_HAIR_03', 'SK_RIVERSPIRIT_F_HAIR_01_Bangs'])
    expect(hairPartNames('m', '02')).toEqual(['SK_RIVERSPIRIT_M_HAIR_02'])
    expect(partBaseName('SK_RIVERSPIRIT_F_HAIR_02__LOD1_primitive0')).toBe('SK_RIVERSPIRIT_F_HAIR_02')
    expect(lookPartOf('SK_RIVERSPIRIT_F_HAIR_01_Bangs_soft')).toEqual({ kind: 'hair', name: 'SK_RIVERSPIRIT_F_HAIR_01_Bangs' })
    expect(lookPartOf('SK_RIVERSPIRIT_F_EARRINGS__LOD2')).toEqual({ kind: 'accessory', id: 'earrings', name: 'SK_RIVERSPIRIT_F_EARRINGS' })
    expect(lookPartOf('SK_RIVERSPIRIT_F_HEAD')).toBeNull()
    expect(lookPartOf('SK_RIVERSPIRIT_F_FLOWERS')).toBeNull() // the outfit's belt flowers are the outfit's
    const look = { ...defaultLook('f'), hair: '05', accessories: ['nails', 'hair_flower'] }
    expect([...lookPartNames(look)].sort()).toEqual(['SK_RIVERSPIRIT_F_HAIR_01', 'SK_RIVERSPIRIT_F_HAIR_FLOWER', 'SK_RIVERSPIRIT_F_NAILS'])
  })

  it('build: the default is the artist shape; girths stay within the safe limits; hands, feet and head keep their size', () => {
    expect(lookBoneTargets('f', LOOK_BUILD_DEFAULT.f).size).toBe(0)
    const max = lookBoneTargets('f', { ...LOOK_BUILD_DEFAULT.f, weight: 100, muscle: 100, shoulders: 100, chest: 100, hips: 100 })
    const min = lookBoneTargets('m', { ...LOOK_BUILD_DEFAULT.m, weight: 0, muscle: 0, shoulders: 0, chest: 0, hips: 0 })
    for (const t of [...max.values(), ...min.values()]) for (const v of t) expect(Math.abs(v - 1)).toBeLessThanOrEqual(BUILD_LIMITS.chest * 1.0001 + 0.1)
    expect(max.get('upperarm_l')![1]).toBeGreaterThan(1)
    expect(max.get('upperarm_l')![0]).toBe(1) // never longer (X runs along the bone)
    expect(max.has('head') || max.has('hand_l') || max.has('foot_l')).toBe(false)
    const parent: Record<string, string | null> = { pelvis: null, thigh_l: 'pelvis', calf_l: 'thigh_l', foot_l: 'calf_l', upperarm_l: null, lowerarm_l: 'upperarm_l', hand_l: 'lowerarm_l' }
    const local = localBoneScales(max, b => parent[b] ?? null, Object.keys(parent))
    // the hand undoes the forearm's girth, the foot the calf's
    const wantHand = local.get('hand_l')!, wantLa = max.get('lowerarm_l')!
    expect(wantHand[1] * wantLa[1]).toBeCloseTo(1)
    expect(local.get('foot_l')![1] * max.get('calf_l')![1]).toBeCloseTo(1)
  })

  it('materials: the file’s own look draws the file’s materials; each change has its own variant key', () => {
    const builtIn = { makeup: '16_04', iris: '01' }
    const d = { ...defaultLook('f'), makeup: '16_04', iris: '01' }
    const p0 = lookMaterialPlan(d, builtIn)
    for (const slot of ['head', 'body', 'eye', 'hair'] as const) expect(slotKey(slot, p0, false)).toBe('')
    const p = lookMaterialPlan({ ...d, makeup: '27', iris: '33', hairColor: 4, skinTone: 12, markings: ['paint_teal'] }, builtIn)
    expect(slotKey('head', p, false)).toMatch(/^head:27:/)
    expect(slotKey('head', p, true)).toMatch(/^head:27@2k:/)
    expect(slotKey('eye', p, false)).toBe('eye:33')
    expect(slotKey('body', p, false)).toMatch(/^body:paint_teal:0\.6/)
    expect(slotKey('hair', p, false)).toMatch(/^hair:/)
    expect(lookSlotOf('MAT_HAIR_soft')).toBe('hair')
    expect(lookSlotOf('MAT_EYE_L')).toBe('eye')
    expect(lookSlotOf('MAT_CLOTHES')).toBeNull()
  })
})

describe('the creator (screens/creator-model.ts)', () => {
  it('new: edits clamp to the catalogue, gender resets the look, the create message carries a valid look', () => {
    const s = newCreator('f')
    expect(edit.makeup(s, '99')).toBe(false)
    expect(edit.makeup(s, '27')).toBe(true)
    expect(edit.iris(s, '05')).toBe(true)
    expect(edit.hairStyle(s, 2)).toBe(true)
    expect(hairOf(s)).toEqual({ style: 2, bangs: true })
    expect(edit.bangs(s, false)).toBe(true)
    expect(s.look.hair).toBe('02')
    expect(edit.hairColor(s, 99)).toBe(true)
    expect(s.look.hairColor).toBe(31)
    expect(edit.skinShift(s, -80)).toBe(true)
    expect(s.look.skinShift).toBe(-50)
    expect(edit.paint(s, 'paint_red')).toBe(true)
    expect(edit.paint(s, 'paint_nope')).toBe(true) // unknown = none
    expect(s.look.markings).toEqual([])
    expect(edit.accessory(s, 'nails', true)).toBe(true)
    expect(edit.accessory(s, 'crown', true)).toBe(false)
    expect(edit.build(s, 'weight', 140)).toBe(true)
    expect(s.look.build.weight).toBe(100)
    expect(edit.height(s, 3)).toBe(true)
    expect(createMessage(s, 'CHAR_CH_WOMAN_ADVENTURER')).toBeNull() // no name yet
    s.name = 'Lin'
    const msg = createMessage(s, 'CHAR_CH_WOMAN_ADVENTURER')!
    expect(msg).toMatchObject({ t: 'charCreate', name: 'Lin', height: 3, outfit: 'clothes', look: { makeup: '27', hair: '02', accessories: ['earrings', 'nails'] } })
    expect(parseLook(msg.look, 'f').ok).toBe(true)
    expect(edit.gender(s, 'm')).toBe(true)
    expect(s.look).toMatchObject({ body: 'm', makeup: '04', accessories: [], height: 3 })
  })

  it('edit: pre-filled from the character, gender fixed; done sends the look, keep sends none', () => {
    const look = { ...defaultLook('m', 7), makeup: '08' }
    const ch: CharacterSummary = { id: 7, name: 'Wei', model: 'CHAR_CH_MAN_ADVENTURER', level: 12, weapon: 'glaive', location: 'Jangan', pos: [0, 0, 0], lastPlayed: 1, look, customise: true }
    const s = editCreator(ch, 'm')
    expect(s.look).toEqual(look)
    expect(edit.gender(s, 'f')).toBe(false)
    edit.iris(s, '20')
    expect(lookMessage(s)).toEqual({ t: 'charLook', id: 7, look: { ...look, iris: '20' } })
    expect(lookMessage(s, true)).toEqual({ t: 'charLook', id: 7 })
    expect(offersCreator(ch, true)).toBe(true)
    expect(offersCreator(ch, false)).toBe(false)
    expect(offersCreator({ ...ch, customise: undefined }, true)).toBe(false)
    // a character without a readable look starts from its body's default
    expect(editCreator({ ...ch, look: undefined, height: 4 }, 'm').look).toEqual(defaultLook('m', 7, 4, 2))
  })
})

describe('the creator sliders stay independent (§16.10)', () => {
  const BUILD_KEYS = ['weight', 'muscle', 'shoulders', 'chest', 'hips'] as const
  const flat = (l: object) => Object.fromEntries(Object.entries(l).flatMap(([k, v]) => (k === 'build' ? Object.entries(v as object).map(([b, x]) => [`build.${b}`, x]) : [[k, JSON.stringify(v)]])))
  const moved = (before: object, after: object) => {
    const a = flat(before), b = flat(after)
    return Object.keys({ ...a, ...b }).filter(k => a[k] !== b[k]).sort()
  }

  it('each slider changes only its own look field, at its min, mid and max', () => {
    for (const body of ['f', 'm'] as const) {
      for (const [field, set, values] of [
        ['height', (s: ReturnType<typeof newCreator>, v: number) => edit.height(s, v), [0, 2, 4]],
        ['skinShift', (s: ReturnType<typeof newCreator>, v: number) => edit.skinShift(s, v), [-50, 0, 50]],
        ...BUILD_KEYS.map(k => [`build.${k}`, (s: ReturnType<typeof newCreator>, v: number) => edit.build(s, k, v), [0, 50, 100]] as const),
      ] as const) {
        for (const v of values) {
          const s = newCreator(body)
          const before = structuredClone(s.look)
          ;(set as (s: ReturnType<typeof newCreator>, v: number) => boolean)(s, v)
          const changed = moved(before, s.look)
          expect(changed.every(k => k === field), `${body} ${field}=${v} moved ${changed.join(',')}`).toBe(true)
        }
      }
    }
  })

  it('no build slider scales a bone along its length (X): the build never changes the height', () => {
    const vertical = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'neck_01', 'neck_02', 'head', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r']
    for (const body of ['f', 'm'] as const)
      for (const k of BUILD_KEYS)
        for (const v of [0, 100]) {
          const t = lookBoneTargets(body, { ...LOOK_BUILD_DEFAULT[body], [k]: v })
          for (const b of vertical) expect(t.get(b)?.[0] ?? 1, `${body} ${k}=${v} ${b}`).toBe(1)
        }
    // each slider moves its own bones: weight the girths, shoulders the clavicles' length, hips the pelvis's width
    const w = lookBoneTargets('f', { ...LOOK_BUILD_DEFAULT.f, weight: 100 })
    expect(w.has('clavicle_l')).toBe(false)
    const sh = lookBoneTargets('f', { ...LOOK_BUILD_DEFAULT.f, shoulders: 100 })
    expect([...sh.keys()].sort()).toEqual(['clavicle_l', 'clavicle_r'])
    expect(sh.get('clavicle_l')![0]).toBeCloseTo(1 + BUILD_LIMITS.shoulders)
    const hp = lookBoneTargets('m', { ...LOOK_BUILD_DEFAULT.m, hips: 100 })
    expect([...hp.keys()]).toEqual(['pelvis'])
    expect(hp.get('pelvis')).toEqual([1, 1, 1 + BUILD_LIMITS.hips])
  })

  // the pack's own skeleton at bind (work/, licensed: skipped where the converter output is absent)
  const glb = fileURLToPath(new URL('../../../work/out/char/licensed/waterbender/waterbender_f_base.glb', import.meta.url))
  it.skipIf(!existsSync(glb))("the build leaves the head bone's world height at bind; height scales it (the pack's skeleton)", () => {
    const buf = readFileSync(glb)
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString()) as { nodes: { name?: string; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[] }
    const scene = new Scene(new NullEngine())
    const root = new TransformNode('root', scene)
    const nodes = json.nodes.map((n, i) => {
      const t = new TransformNode(n.name ?? `n${i}`, scene)
      if (n.translation) t.position = Vector3.FromArray(n.translation)
      t.rotationQuaternion = n.rotation ? Quaternion.FromArray(n.rotation) : Quaternion.Identity()
      if (n.scale) t.scaling = Vector3.FromArray(n.scale)
      return t
    })
    const parentOf = new Map<string, string | null>()
    json.nodes.forEach((n, i) => (n.children ?? []).forEach(c => (nodes[c]!.parent = nodes[i]!, parentOf.set(nodes[c]!.name, nodes[i]!.name))))
    for (const n of nodes) if (!n.parent) n.parent = root
    const byName = new Map(nodes.map(n => [n.name, n]))
    const measure = (body: 'f', build: typeof LOOK_BUILD_DEFAULT.f, height = 2) => {
      for (const n of nodes) n.scaling.setAll(1)
      for (const [b, s] of localBoneScales(lookBoneTargets(body, build), b => parentOf.get(b) ?? null, byName.keys())) byName.get(b)!.scaling.set(...s)
      root.scaling.setAll(heightScale(height))
      for (const n of [root, ...nodes]) n.computeWorldMatrix(true)
      const p = (b: string) => byName.get(b)!.getAbsolutePosition()
      return { head: p('head').y - p('foot_l').y, shoulders: Vector3.Distance(p('upperarm_l'), p('upperarm_r')), hips: Vector3.Distance(p('thigh_l'), p('thigh_r')) }
    }
    const d = measure('f', LOOK_BUILD_DEFAULT.f)
    expect(d.head).toBeGreaterThan(1.3)
    for (const k of BUILD_KEYS)
      for (const v of [0, 100]) {
        const m = measure('f', { ...LOOK_BUILD_DEFAULT.f, [k]: v })
        expect(Math.abs(m.head - d.head), `${k}=${v} head`).toBeLessThan(0.001) // under a millimetre
        if (k === 'shoulders') expect(Math.abs(m.shoulders - d.shoulders)).toBeGreaterThan(0.005)
        else expect(Math.abs(m.shoulders - d.shoulders), `${k}=${v} shoulders`).toBeLessThan(0.001)
        if (k === 'hips' || k === 'weight') expect(Math.abs(m.hips - d.hips)).toBeGreaterThan(0.003)
        else expect(Math.abs(m.hips - d.hips), `${k}=${v} hips`).toBeLessThan(0.001)
      }
    // height: the root scale only; every proportion stays (no widening beyond the uniform scale)
    for (const h of [0, 4]) {
      const m = measure('f', LOOK_BUILD_DEFAULT.f, h)
      const k = heightScale(h) / heightScale(2)
      expect(m.head / d.head).toBeCloseTo(k, 5)
      expect(m.shoulders / d.shoulders).toBeCloseTo(k, 5)
    }
    scene.dispose()
  })
})
