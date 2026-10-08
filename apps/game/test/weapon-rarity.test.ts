/**
 * Rare weapons on the client (docs/RARITY.md §5): the three looks (each its own colour and pattern), the material
 * plugin's code in both shader languages and on a NullEngine PBRMaterial (per-mesh defines on a shared material, the
 * lite code on Low, per-tier values), the motes (cap, your own first, Low at half), the actor plumbing (a seal is drawn
 * with its regular model and dressed in its tier; the fallback weapon never), the trail colour, the drop beam, the
 * chimes, the tooltip (name colour and banner), the slot frame and the notice sentence.
 */
import {
  AbstractMesh,
  ArcRotateCamera,
  AssetContainer,
  Bone,
  Matrix,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Scene,
  ShaderStore,
  Skeleton,
  TransformNode,
  Vector3,
  type Mesh,
  type UniformBuffer,
} from '@babylonjs/core'
import '@babylonjs/core/Shaders/pbr.fragment.js'
import '@babylonjs/core/ShadersWGSL/pbr.fragment.js'
import { RARITY, RARITY_TIERS, type ItemDef } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { chimePcm } from '../src/world/rarity/chimes.ts'
import { BEAM_SHAPES, beamAlpha } from '../src/world/rarity-beam.ts'
import { rarityTrail } from '../src/world/skill-fx.ts'
import { rareNoticeText } from '../src/world/features/rarity.ts'
import { ItemCatalog } from '../src/hud/items.ts'
import { slotSigns } from '../src/hud/slots.ts'
import { TOOLTIP_STYLES } from '../src/ui/kit/tooltip.ts'
import { CharacterActor, modelCodes, rarityBySlot } from '../src/three/models.ts'
import type { GlowOwner } from '../src/three/weapon-glow.ts'
import {
  MOTE_CAPS,
  MOTE_RANGE_M,
  RARITY_DEFINES,
  RARITY_LOOKS,
  RARITY_PLUGIN,
  RARITY_UNIFORMS,
  RarityMotes,
  WeaponRarity,
  moteAt,
  pickMotes,
  rarityCode,
  rarityModeFor,
  rarityPluginOf,
  rarityValues,
  type RareItem,
  type RarityMode,
} from '../src/three/weapon-rarity.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function nullScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  new ArcRotateCamera('cam', 0, 1.2, 4, Vector3.Zero(), scene)
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

function pbrSources(lang: 'wgsl' | 'glsl'): string {
  const main = lang === 'wgsl' ? ShaderStore.ShadersStoreWGSL.pbrPixelShader : ShaderStore.ShadersStore.pbrPixelShader
  const includes = lang === 'wgsl' ? ShaderStore.IncludesShadersStoreWGSL : ShaderStore.IncludesShadersStore
  return [main, ...Object.values(includes)].join('\n')
}

async function ready(mesh: AbstractMesh): Promise<boolean> {
  const mat = mesh.material as PBRMaterial
  for (let i = 0; i < 50; i++) {
    mesh.getScene().incrementRenderId()
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return false
}

const definesOf = (mesh: AbstractMesh) => mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>

function sword(scene: Scene, mat?: PBRMaterial, name = 'sword') {
  const root = new TransformNode(`${name}:root`, scene)
  const mesh = MeshBuilder.CreateBox(name, { width: 0.06, height: 0.02, depth: 0.9 }, scene)
  mesh.position.z = 0.35
  mesh.parent = root
  mesh.material = mat ?? new PBRMaterial(`${name}:mat`, scene)
  const dummies = new Map([
    ['ai_start', new Vector3(-0.008, 0, 0.101)],
    ['ai_end', new Vector3(-0.013, 0, 0.759)],
  ])
  return { root, mesh, dummies }
}

const owner = (scene: Scene, self = false, offscreen = false): GlowOwner => ({ root: new TransformNode('owner', scene), lodFull: self, isOffscreen: offscreen })

describe('the looks', () => {
  it('one per tier, each its own kind, colours, sprite and trail; Sun the boldest', () => {
    const looks = RARITY_TIERS.map(t => RARITY_LOOKS[t])
    expect(looks.map(l => l.kind)).toEqual([1, 2, 3])
    expect(new Set(looks.map(l => l.tint.join())).size).toBe(3)
    expect(new Set(looks.map(l => l.rim.join())).size).toBe(3)
    expect(new Set(looks.map(l => l.sprite)).size).toBe(3)
    expect(new Set(looks.map(l => l.trail.join())).size).toBe(3)
    expect(RARITY_LOOKS.sun.rimGain).toBeGreaterThan(RARITY_LOOKS.star.rimGain)
    expect(RARITY_LOOKS.sun.trailLength).toBeGreaterThan(RARITY_LOOKS.star.trailLength)
  })
})

describe('plugin code', () => {
  it('uses PBR fragment points of both languages and only names they have', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = pbrSources(lang)
      for (const point of Object.keys(rarityCode(lang))) expect(src.includes(`#define ${point}`), `${lang} ${point}`).toBe(true)
      for (const n of ['finalEmissive', 'normalW', 'viewDirectionW', 'vPositionW', 'surfaceAlbedo', 'vAlbedoUV']) expect(src.includes(n), `${lang} ${n}`).toBe(true)
    }
    expect(Object.keys(rarityCode('wgsl'))).toEqual(Object.keys(rarityCode('glsl')))
  })

  it('no GLSL idiom in the WGSL and the reverse; #if closed; the lite branch reads no world matrix or normal', () => {
    for (const key of Object.keys(rarityCode('wgsl'))) {
      const wgsl = rarityCode('wgsl')[key]!
      const glsl = rarityCode('glsl')[key]!
      expect(wgsl).not.toMatch(/\b(float|vec[234]|texture2D|gl_\w+)\s*[(\s]/)
      expect(wgsl).not.toMatch(/[^=!<>+\-*/]\+=|\*=/)
      expect(glsl).not.toMatch(/\b(fn|let|var)\s|vec[234]f\(|fragmentInputs|uniforms\./)
      for (const code of [wgsl, glsl]) {
        expect((code.match(/^#if/gm) ?? []).length).toBe((code.match(/^#endif/gm) ?? []).length)
        expect(code.trim().startsWith('#ifdef SRORARE\n')).toBe(true)
      }
    }
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = rarityCode(lang).CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION!
      const lite = code.slice(code.indexOf('#ifdef SRORARE_LITE'), code.indexOf('#else'))
      expect(lite).not.toMatch(/world|normalW|vPositionW|smoothstep/)
    }
  })
})

describe('the plugin on a NullEngine PBRMaterial', () => {
  it('per-mesh SRORARE on a shared material, the lite code on Low, and each mesh its own tier values', async () => {
    const scene = nullScene()
    let mode: RarityMode = { lite: false, moteCap: 6 }
    const rare = new WeaponRarity(scene, { mode: () => mode, now: () => 10, exposure: () => 1 })
    cleanups.push(() => rare.dispose())
    const mat = new PBRMaterial('sword_01', scene)
    const a = sword(scene, mat, 'a')
    const b = sword(scene, mat, 'b')
    const c = sword(scene, mat, 'c')
    rare.prepare([a.mesh, b.mesh, c.mesh])
    expect(mat.pluginManager?.getPlugin(RARITY_PLUGIN)).toBe(rarityPluginOf(mat))
    rare.light(owner(scene), { meshes: [a.mesh], root: a.root, dummies: a.dummies }, 'star')
    rare.light(owner(scene), { meshes: [b.mesh], root: b.root, dummies: b.dummies }, 'sun')
    for (const m of [a.mesh, b.mesh, c.mesh]) expect(await ready(m)).toBe(true)
    expect([definesOf(a.mesh).SRORARE, definesOf(b.mesh).SRORARE, definesOf(c.mesh).SRORARE]).toEqual([true, true, false])
    expect(definesOf(a.mesh).SRORARE_LITE).toBe(false)
    const plugin = rarityPluginOf(mat)!
    const written = (m: Mesh) => {
      const calls: Record<string, number[]> = {}
      const ubo = { updateFloat4: (n: string, x: number, y: number, z: number, w: number) => void (calls[n] = [x, y, z, w]) } as unknown as UniformBuffer
      plugin.hardBindForSubMesh(ubo, scene, scene.getEngine(), m.subMeshes[0]!)
      return calls
    }
    const wa = written(a.mesh)
    const wb = written(b.mesh)
    expect(Object.keys(wa).sort()).toEqual([...RARITY_UNIFORMS].sort())
    expect(wa.sroRareT![3]).toBe(1)
    expect(wb.sroRareT![3]).toBe(3)
    expect(Object.keys(written(c.mesh))).toEqual([])
    mode = { lite: true, moteCap: 1 }
    rare.frame()
    expect(await ready(a.mesh)).toBe(true)
    expect(definesOf(a.mesh).SRORARE_LITE).toBe(true)
    // null clears; a disposed mesh clears
    rare.light(owner(scene), { meshes: [a.mesh], root: a.root, dummies: a.dummies }, null)
    expect(rare.stateOf(a.mesh)).toBeNull()
    expect(rare.live.size).toBe(1)
    b.mesh.dispose()
    expect(rare.live.size).toBe(0)
    expect(Object.keys(RARITY_DEFINES)).toEqual(['SRORARE', 'SRORARE_LITE'])
  })

  it('lite values are smaller than the full ones; the exposure divides them', () => {
    const it0 = { look: RARITY_LOOKS.moon, phase: 0, tint: { r: 1, g: 1, b: 1 }, rim: { r: 1, g: 1, b: 1 }, accent: { r: 1, g: 1, b: 1 } } as unknown as RareItem
    const r = { item: it0, origin: Vector3.Zero(), axis: Vector3.Forward(), mask: [0, 0, 1, 1] as const }
    const full = rarityValues(r, 5, false, 1)
    const lite = rarityValues(r, 5, true, 1)
    const noon = rarityValues(r, 5, false, 1 / 11)
    expect(lite[2]!).toBeLessThan(full[2]!)
    expect(lite[3]!).toBeLessThan(full[3]!)
    expect(noon[3]!).toBeCloseTo(full[3]! / 11, 6)
    expect(full[7]).toBe(2)
  })
})

describe('motes', () => {
  it('caps per preset (Low: your own only)', () => {
    expect(rarityModeFor({ render: 'classic', renderPreset: 'medium' })).toEqual({ lite: true, moteCap: MOTE_CAPS.low })
    expect(rarityModeFor({ render: 'pbr', renderPreset: 'high' })).toEqual({ lite: false, moteCap: MOTE_CAPS.high })
    expect(MOTE_CAPS.low).toBe(1)
  })

  it('stay within their life and size; mist and embers rise, embers faster', () => {
    for (const kind of [1, 2, 3]) {
      for (let s = 0; s < 6; s += 0.137) {
        for (let i = 0; i < 9; i++) {
          const m = moteAt(kind, i, 0.3, s)
          expect(m.alpha).toBeGreaterThanOrEqual(0)
          expect(m.alpha).toBeLessThanOrEqual(1)
          expect(m.t).toBeGreaterThanOrEqual(0.08)
          expect(m.t).toBeLessThanOrEqual(1)
          expect(m.size).toBeGreaterThan(0)
          if (kind > 1) expect(m.up).toBeGreaterThanOrEqual(0)
        }
      }
    }
    let moon = 0
    let sun = 0
    for (let s = 0; s < 20; s += 0.05) {
      moon = Math.max(moon, moteAt(2, 0, 0.1, s).up)
      sun = Math.max(sun, moteAt(3, 0, 0.1, s).up)
    }
    expect(sun).toBeGreaterThan(moon)
  })

  it('your own first, then the nearest within range, at most the cap; one batch; Low draws half', () => {
    const scene = nullScene()
    scene.activeCamera!.position.set(0, 2, -4)
    const rare = new WeaponRarity(scene, { exposure: () => 1, now: () => 1 })
    cleanups.push(() => rare.dispose())
    const at = (x: number, self = false) => {
      const s = sword(scene)
      const o = owner(scene, self)
      o.root.position.x = x
      s.root.parent = o.root
      return rare.light(o, { meshes: [s.mesh], root: s.root, dummies: s.dummies }, 'sun')!
    }
    const far = at(MOTE_RANGE_M + 20)
    const near = at(3)
    const mid = at(10)
    const mine = at(25, true)
    const eye = scene.activeCamera!.globalPosition
    expect(pickMotes(rare.live, 2, eye)).toEqual([mine, near])
    expect(pickMotes(rare.live, 10, eye)).toEqual([mine, near, mid])
    expect(pickMotes(rare.live, 10, eye)).not.toContain(far)
    const motes = rare.motes as RarityMotes
    motes.update(rare.live, { lite: false, moteCap: 6 }, 1.234)
    expect(motes.shown.length).toBe(3)
    expect(motes.drawn).toBeLessThanOrEqual(3 * RARITY_LOOKS.sun.motes)
    expect(motes.drawn).toBeGreaterThan(0)
    motes.update(rare.live, { lite: true, moteCap: 1 }, 1.234)
    expect(motes.shown).toEqual([mine])
    expect(motes.drawn).toBeLessThanOrEqual(Math.ceil(RARITY_LOOKS.sun.motes / 2))
  })
})

// ---- the actor ----------------------------------------------------------------------------------------------------

const HAND = 'Bip01 R HandMid'

function playerActor(scene: Scene): CharacterActor {
  const root = new TransformNode('__root__', scene)
  const body = MeshBuilder.CreateBox('body', { size: 1 }, scene)
  body.parent = root
  const hand = new TransformNode(HAND, scene)
  hand.parent = root
  const skel = new Skeleton('skel', 'skel', scene)
  new Bone(HAND, skel, null, Matrix.Translation(0.3, 1.1, 0)).linkTransformNode(hand)
  body.skeleton = skel
  const c = new AssetContainer(scene)
  c.moveAllFromScene()
  return new CharacterActor(scene, { code: 'CHAR_CH_MAN_ADVENTURER', glb: '/out/test.glb' }, { container: c, sidecar: null, packs: null })
}

function swordContainer(scene: Scene): AssetContainer {
  const root = new TransformNode('__root__', scene)
  const mesh = MeshBuilder.CreateBox('sword_03', { width: 0.06, height: 0.02, depth: 0.9 }, scene)
  mesh.parent = root
  const mat = new PBRMaterial('sword3', scene)
  mesh.material = mat
  const c = new AssetContainer(scene)
  c.transformNodes.push(root)
  c.meshes.push(mesh)
  c.materials.push(mat)
  c.removeAllFromScene()
  return c
}

const SWORD_SIDECAR = { dummies: { ai_start: [-0.008, 0, 0.101], ai_end: [-0.013, 0, 0.759] } }

describe('actor plumbing', () => {
  it('a seal is drawn with its regular model and dressed in its tier; the fallback weapon never shows one', () => {
    expect(modelCodes({ weapon: 'ITEM_CH_SWORD_03_C_RARE', chest: 'ITEM_CH_M_HEAVY_03_BA_A' })).toEqual({ weapon: 'ITEM_CH_SWORD_03_A', chest: 'ITEM_CH_M_HEAVY_03_BA_A' })
    expect(rarityBySlot({ weapon: 'ITEM_CH_SWORD_03_B_RARE', shield: 'ITEM_CH_SHIELD_03_A' })).toEqual({ weapon: 'moon' })
    expect(rarityBySlot(undefined)).toEqual({})
    const scene = nullScene()
    const rare = new WeaponRarity(scene, { exposure: () => 1 })
    cleanups.push(() => rare.dispose())
    const actor = playerActor(scene)
    actor.rarityFx = rare
    const dress = (slot: 'weapon' | 'fallback', rarity: Record<string, string> | undefined) => {
      actor.beginDress()
      const container = swordContainer(scene)
      actor.applyDress({
        comp: null,
        items: slot === 'weapon' ? [{ item: { code: 'ITEM_CH_SWORD_03_A', slot: 'weapon', kind: 'socket', glb: '/out/sword_03.glb', attachBone: HAND } as never, container, sidecar: SWORD_SIDECAR }] : [],
        fallback: slot === 'fallback' ? { container, attachBone: HAND, sidecar: SWORD_SIDECAR } : null,
        family: 'sword',
        gender: 'male',
        volume: undefined,
        rarity,
      } as Parameters<CharacterActor['applyDress']>[0])
    }
    dress('weapon', { weapon: 'sun' })
    expect([...rare.live].map(i => i.tier)).toEqual(['sun'])
    expect(actor.weaponRarity).toBe('sun')
    expect(rarityPluginOf([...rare.live][0]!.meshes[0]!.material)).not.toBeNull()
    dress('weapon', undefined)
    expect(rare.live.size).toBe(0)
    expect(actor.weaponRarity).toBeNull()
    dress('fallback', { weapon: 'star' })
    expect(rare.live.size).toBe(0)
    actor.dispose()
  })
})

describe('trail, beam and chimes', () => {
  it('a seal colours the row trail in its tier and blend, longer', () => {
    const row = { lengthMs: 200, color: [1, 1, 1, 0.5] as [number, number, number, number], blend: 'alpha' as const, texture: 'fx/tex/a.png' }
    const sun = rarityTrail(row, 'sun')
    expect(sun.texture).toBe(row.texture)
    expect(sun.blend).toBe(RARITY_LOOKS.sun.trailBlend)
    expect(rarityTrail(row, 'moon').blend).toBe('add')
    expect(sun.lengthMs).toBe(300)
    expect(sun.color).toEqual([...RARITY_LOOKS.sun.trail, RARITY_LOOKS.sun.trailAlpha])
    expect(rarityTrail(row, 'star').color).not.toEqual(sun.color)
  })

  it('the beam grows from Star to Sun and pulses within (0, 1]', () => {
    expect(BEAM_SHAPES.star.height).toBeLessThan(BEAM_SHAPES.moon.height)
    expect(BEAM_SHAPES.moon.height).toBeLessThan(BEAM_SHAPES.sun.height)
    for (const tier of RARITY_TIERS) {
      for (let s = 0; s < 5; s += 0.1) {
        const a = beamAlpha(BEAM_SHAPES[tier], s)
        expect(a).toBeGreaterThan(0)
        expect(a).toBeLessThanOrEqual(1)
      }
    }
  })

  it('three chimes: different lengths, normalised, not silent', () => {
    const pcms = RARITY_TIERS.map(t => chimePcm(t))
    expect(new Set(pcms.map(p => p.samples.length)).size).toBe(3)
    for (const p of pcms) {
      let peak = 0
      for (const v of p.samples) peak = Math.max(peak, Math.abs(v))
      expect(peak).toBeCloseTo(0.85, 2)
    }
  })
})

describe('HUD', () => {
  const sun: ItemDef = { code: 'ITEM_CH_SWORD_03_C_RARE', id: 4022, name: 'Sharp Sword', typeId: [3, 1, 6, 2], category: 'weapon', slot: 'weapon', weaponType: 'sword', degree: 3, reqLevel: 16, reqGender: 'any', race: 'china', maxStack: 1, price: 135000, sellPrice: 47250, model: null, icon: null, stats: { physAttack: [130, 146] } }
  const plain: ItemDef = { ...sun, code: 'ITEM_CH_SWORD_03_C', id: 79, name: 'Spiritual Sharp Sword' }
  const catalog = new ItemCatalog([sun, plain])

  it('a seal\'s name in its tier colour with the seal banner under it; a regular sword unchanged', () => {
    const lines = catalog.tooltip({ code: sun.code, count: 1, plus: 7 })
    expect(lines[0]).toEqual({ text: 'Sharp Sword (+7)', cls: 'title-sun' })
    expect(lines[1]).toEqual({ text: '☀ Seal of Sun ☀', cls: 'rare-sun' })
    expect(TOOLTIP_STYLES['title-sun']).toContain('rarity sun')
    expect(TOOLTIP_STYLES['rare-moon']).toBe('kit-tt-rarity moon')
    const p = catalog.tooltip({ code: plain.code, count: 1, plus: 3 })
    expect(p[0]!.cls).toBe('title-plus')
    expect(p.some(l => l.cls.startsWith('rare-'))).toBe(false)
  })

  it('the slot shows the tier frame (with the retail rare sign); the notice names the seal', () => {
    expect(slotSigns({ code: sun.code, count: 1, plus: 2 }, sun)).toMatchObject({ rare: true, rarity: 'sun', plus: 2 })
    expect(slotSigns({ code: plain.code, count: 1 }, plain).rarity).toBeUndefined()
    const n = rareNoticeText({ t: 'rareNotice', by: 'Mei', item: sun.code, name: 'Sharp Sword', tier: 'moon' })
    expect(n.text).toBe(`Mei found a ${RARITY.moon.name} weapon: Sharp Sword!`)
    expect(n.name).toBe('Sharp Sword')
  })
})
