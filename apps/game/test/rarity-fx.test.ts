/**
 * Rare weapons v2 (docs/RARITY.md §5): every weapon kind its own effects (kinds.ts: per-type selection and profiles,
 * Star < Moon < Sun), the LOD of the effects layer (your own always full, the nearest within the preset's cap full,
 * then mid, the rest only the blade; Classic your own only), the effect atlas (cells inside, no overlap, UVs), the
 * one-draw batch (shaders in both languages, pooled growth), the particle pool, and the effects layer on a NullEngine
 * scene (lit items, swings, crits, kills, arrows, drops; nothing allocated once warm).
 */
import { ArcRotateCamera, MeshBuilder, NullEngine, PBRMaterial, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { RARITY_TIERS } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { RARITY_LOOKS as RARITY_LOOKS_T, WeaponRarity, rarityValues, type RareItem } from '../src/three/weapon-rarity.ts'
import type { GlowOwner } from '../src/three/weapon-glow.ts'
import { ATLAS_H, ATLAS_W, SPRITES, overlaps, spriteUv, type SpriteName } from '../src/world/rarity/atlas.ts'
import { FxBatch, RARITY_BATCH_SHADERS } from '../src/world/rarity/batch.ts'
import { FULL_RANGE_M, lodCaps, lodList, rarityFx, rarityFxOf } from '../src/world/rarity/fx.ts'
import { RARE_KINDS, rareKindOf, rareKindOfCode, rareProfile } from '../src/world/rarity/kinds.ts'
import { Particles } from '../src/world/rarity/paint.ts'
import { BEAM_SHAPES, RarityBeam } from '../src/world/rarity-beam.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function nullScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  new ArcRotateCamera('cam', 0, 1.2, 6, Vector3.Zero(), scene)
  cleanups.push(() => {
    rarityFxOf(scene)?.dispose()
    scene.dispose()
    engine.dispose()
  })
  return scene
}

function sword(scene: Scene, x = 0) {
  const owner = new TransformNode('owner', scene)
  owner.position.x = x
  const root = new TransformNode('sword:root', scene)
  root.parent = owner
  root.position.y = 1.1
  const mesh = MeshBuilder.CreateBox('sword', { width: 0.06, height: 0.02, depth: 0.9 }, scene)
  mesh.position.z = 0.35
  mesh.parent = root
  mesh.material = new PBRMaterial('sword:mat', scene)
  const dummies = new Map([
    ['ai_start', new Vector3(-0.008, 0, 0.101)],
    ['ai_end', new Vector3(-0.013, 0, 0.759)],
  ])
  return { owner, root, mesh, dummies }
}

const ownerOf = (root: TransformNode, self = false, family: string | null = 'sword'): GlowOwner & { family: string | null } => ({ root, lodFull: self, isOffscreen: false, family })

describe('every weapon its own rarity', () => {
  it('kind from the code and from the slot and family', () => {
    expect(rareKindOfCode('ITEM_CH_SWORD_03_A_RARE')).toBe('sword')
    expect(rareKindOfCode('ITEM_CH_BLADE_02_C_RARE')).toBe('blade')
    expect(rareKindOfCode('ITEM_CH_SPEAR_01_B_RARE')).toBe('spear')
    expect(rareKindOfCode('ITEM_CH_TBLADE_03_C_RARE')).toBe('glaive')
    expect(rareKindOfCode('ITEM_CH_BOW_03_A_RARE')).toBe('bow')
    expect(rareKindOfCode('ITEM_CH_SHIELD_03_B_RARE')).toBe('shield')
    expect(rareKindOfCode('ITEM_ETC_AMMO_ARROW_01')).toBeNull()
    expect(rareKindOfCode(undefined)).toBeNull()
    expect(rareKindOf('shield', 'blade')).toBe('shield')
    expect(rareKindOf('weapon', 'glaive')).toBe('glaive')
    expect(rareKindOf('weapon', 'bow')).toBe('bow')
    expect(rareKindOf('weapon', null)).toBe('sword')
  })

  it('each kind draws its own swing; each tier is a clear step up', () => {
    const shapes = new Set(RARE_KINDS.map(k => rareProfile('star', k).swing))
    expect([...shapes].sort()).toEqual(['arc', 'none', 'shot', 'sweep', 'thrust'])
    expect(rareProfile('sun', 'spear').swing).toBe('thrust')
    expect(rareProfile('sun', 'glaive').swing).toBe('sweep')
    expect(rareProfile('moon', 'bow').swing).toBe('shot')
    expect(rareProfile('star', 'shield').emblem).toBe('shield')
    for (const k of RARE_KINDS) {
      const [s, m, u] = RARITY_TIERS.map(t => rareProfile(t, k))
      expect(m!.motes).toBeGreaterThan(s!.motes - 1e-9)
      expect(u!.motes).toBeGreaterThan(m!.motes - 1e-9)
      if (k !== 'shield' && k !== 'bow') {
        expect(u!.reach).toBeGreaterThan(s!.reach)
        expect(m!.linger).toBeGreaterThan(s!.linger)
      }
    }
    // the glaive's sweep reaches farther than a sword's arc
    expect(rareProfile('sun', 'glaive').reach).toBeGreaterThan(rareProfile('sun', 'sword').reach)
  })

  it('a lit item knows its kind (the shield slot, the wearer\'s family) and its blade frame', () => {
    const scene = nullScene()
    const rare = new WeaponRarity(scene, { exposure: () => 1, now: () => 1 })
    cleanups.push(() => rare.dispose())
    const a = sword(scene)
    const item = rare.light(ownerOf(a.owner, false, 'glaive'), { meshes: [a.mesh], root: a.root, dummies: a.dummies }, 'sun')!
    expect(item.kind).toBe('glaive')
    // the region comes from the model's own geometry (region.ts): on the 0.9 m box, within it
    expect(item.length).toBeGreaterThan(0.1)
    expect(item.length).toBeLessThanOrEqual(0.91)
    expect(Math.abs(Vector3.Dot(item.across.normalizeToNew(), item.tip.subtract(item.base).normalize()))).toBeLessThan(1e-3)
    expect(item.halfWidth).toBeGreaterThan(0.005)
    const b = sword(scene)
    const shield = rare.light(ownerOf(b.owner), { meshes: [b.mesh], root: b.root, dummies: new Map(), slot: 'shield' }, 'moon')!
    expect(shield.kind).toBe('shield')
    // the lit items join the scene's effects layer
    expect(rarityFxOf(scene)).not.toBeNull()
  })

  it('the equip flare plays on your own new seal only, and fades', () => {
    const scene = nullScene()
    let now = 10
    const rare = new WeaponRarity(scene, { exposure: () => 1, now: () => now })
    cleanups.push(() => rare.dispose())
    rare.frame()
    const a = sword(scene)
    const me = ownerOf(a.owner, true)
    const it1 = rare.light(me, { meshes: [a.mesh], root: a.root, dummies: a.dummies }, 'sun')!
    expect(it1.flare).toBe(true)
    const r = rare.stateOf(a.mesh)!
    expect(rarityValues(r, 10.8, false)[38]).toBeGreaterThan(0.5)
    expect(rarityValues(r, 20, false)[38]).toBe(0)
    // relit with the same tier (a +N change): no second flare; somebody else's: none
    expect(rare.light(me, { meshes: [a.mesh], root: a.root, dummies: a.dummies }, 'sun')!.flare).toBe(false)
    const b = sword(scene)
    expect(rare.light(ownerOf(b.owner, false), { meshes: [b.mesh], root: b.root, dummies: b.dummies }, 'moon')!.flare).toBe(false)
    now = 11
  })
})

describe('LOD', () => {
  it('your own always full; the nearest within the cap and range full, then mid, then the blade only', () => {
    const caps = lodCaps({ lite: false, moteCap: 2 })
    expect(caps).toEqual({ full: 2, mid: 4, lite: false })
    const list = lodList(
      [
        { self: true, distance: 40 },
        { self: false, distance: 3 },
        { self: false, distance: 5 },
        { self: false, distance: 7 },
        { self: false, distance: FULL_RANGE_M + 5 },
        { self: false, distance: 25 },
        { self: false, distance: 26 },
        { self: false, distance: 27 },
      ],
      caps,
    )
    expect(list).toEqual(['full', 'full', 'mid', 'mid', 'mid', 'mid', 'far', 'far'])
    // far ones beyond the full range are mid at best
    expect(lodList([{ self: false, distance: FULL_RANGE_M + 1 }], caps)).toEqual(['mid'])
  })

  it('Classic (lite): your own only', () => {
    const caps = lodCaps({ lite: true, moteCap: 1 })
    expect(lodList([{ self: true, distance: 2 }, { self: false, distance: 2 }], caps)).toEqual(['full', 'far'])
  })

  it('the layer: 20 Sun wielders draw one batch; the nearest are full, the far ones only their blades', () => {
    const scene = nullScene()
    scene.activeCamera!.position.set(0, 2, -6)
    const rare = new WeaponRarity(scene, { exposure: () => 1, mode: () => ({ lite: false, moteCap: 6 }) })
    cleanups.push(() => rare.dispose())
    const items: RareItem[] = []
    for (let i = 0; i < 20; i++) {
      const s = sword(scene, i * 3)
      items.push(rare.light(ownerOf(s.owner, i === 0), { meshes: [s.mesh], root: s.root, dummies: s.dummies }, 'sun')!)
    }
    const fx = rarityFx(scene)
    fx.frame()
    fx.frame()
    const st = fx.stats()
    expect(st.full).toBeGreaterThanOrEqual(1)
    expect(st.full).toBeLessThanOrEqual(6)
    expect(st.full + st.mid + st.far).toBe(20)
    expect(st.far).toBeGreaterThan(0)
    expect(st.quads).toBeGreaterThan(0)
    expect(fx.batch.mesh.isVisible).toBe(true)
    // warm: the pools do not grow frame to frame
    for (let i = 0; i < 30; i++) fx.frame()
    const cap = (fx.batch as unknown as { capacity: number }).capacity
    for (let i = 0; i < 60; i++) fx.frame()
    expect((fx.batch as unknown as { capacity: number }).capacity).toBe(cap)
  })
})

describe('moments', () => {
  it('swings, crits, kills, arrows and the equip flare on a rare wielder; nothing for a regular one', () => {
    const scene = nullScene()
    const rare = new WeaponRarity(scene, { exposure: () => 1 })
    cleanups.push(() => rare.dispose())
    const s = sword(scene)
    const me = ownerOf(s.owner, true)
    rare.light(me, { meshes: [s.mesh], root: s.root, dummies: s.dummies }, 'moon')
    const fx = rarityFx(scene)
    fx.frame()
    expect(fx.swing(me, 0.5)).toBe(true)
    expect(fx.impact(me, new Vector3(0, 1, 1.5), 'crit')).toBe(true)
    expect(fx.impact(me, new Vector3(0, 1, 1.5), 'kill')).toBe(true)
    expect(fx.equipFlare(me)).toBe(true)
    let k = 0
    expect(fx.arrow(me, () => ({ pos: [0, 1.4, k++ * 0.2] }), () => k > 20)).toBe(true)
    for (let i = 0; i < 5; i++) fx.frame()
    // crit, kill, the flare of lighting your own new seal, and the one asked for
    expect(fx.stats().bursts).toBe(4)
    const stranger = ownerOf(new TransformNode('x', scene))
    expect(fx.swing(stranger, 0.5)).toBe(false)
    expect(fx.impact(stranger, Vector3.Zero(), 'crit')).toBe(false)
  })

  it('a drop: its moment when fresh, its mark when found lying there; disposing it stops both', () => {
    const scene = nullScene()
    const node = new TransformNode('drop', scene)
    const beam = new RarityBeam(scene, 'sun', node)
    const fx = rarityFx(scene)
    fx.frame()
    expect(fx.stats().drops).toBe(1)
    beam.setEnabled(false)
    fx.frame()
    expect(fx.stats().drops).toBe(0)
    beam.setEnabled(true)
    beam.dispose()
    fx.frame()
    expect(fx.stats().drops).toBe(0)
    expect(BEAM_SHAPES.star.height).toBeLessThan(BEAM_SHAPES.moon.height)
    expect(BEAM_SHAPES.moon.height).toBeLessThan(BEAM_SHAPES.sun.height)
  })
})

describe('art and batch', () => {
  it('every atlas cell inside the atlas, none overlapping, UVs inside their cell', () => {
    const names = Object.keys(SPRITES) as SpriteName[]
    for (const n of names) {
      const s = SPRITES[n]
      expect(s.x + s.w).toBeLessThanOrEqual(ATLAS_W)
      expect(s.y + s.h).toBeLessThanOrEqual(ATLAS_H)
      const [u0, v0, u1, v1] = spriteUv(n)
      expect(u0).toBeGreaterThan(s.x / ATLAS_W)
      expect(u1).toBeLessThan((s.x + s.w) / ATLAS_W)
      expect(v0).toBeGreaterThan(s.y / ATLAS_H)
      expect(v1).toBeLessThan((s.y + s.h) / ATLAS_H)
    }
    for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) expect(overlaps(SPRITES[names[a]!], SPRITES[names[b]!]), `${names[a]} ${names[b]}`).toBe(false)
  })

  it('batch shaders in both languages; the pool grows by doubling and only on demand', () => {
    expect(RARITY_BATCH_SHADERS.wgsl.fragment).toMatch(/textureSampleLevel\(rfAtlas/)
    expect(RARITY_BATCH_SHADERS.glsl.fragment).toMatch(/textureLod\(rfAtlas/)
    expect(RARITY_BATCH_SHADERS.wgsl.fragment).not.toMatch(/\b(float|vec[234])\s*[(\s]/)
    expect(RARITY_BATCH_SHADERS.glsl.fragment).not.toMatch(/\b(fn|let|var)\s|vec[234]f\(/)
    const scene = nullScene()
    const b = new FxBatch(scene, 64)
    cleanups.push(() => b.dispose())
    const c = { r: 1, g: 1, b: 1, a: 0 }
    b.begin()
    for (let i = 0; i < 100; i++) b.quad(0, 0, 0, 1, 0, 0, 0, 1, 0, 'flare', c)
    b.end()
    expect(b.count).toBe(100)
    expect((b as unknown as { capacity: number }).capacity).toBe(128)
    expect(b.mesh.subMeshes[0]!.indexCount).toBe(600)
    b.begin()
    b.end()
    expect(b.mesh.isVisible).toBe(false)
  })

  it('particles: a fixed pool; the oldest is replaced; they age out', () => {
    const p = new Particles(8)
    for (let i = 0; i < 20; i++) p.emit(0, 0, 0, 0, 1, 0, 1, 0.1, 0, 0, [1, 1, 1], [1, 1, 1], 1)
    p.step(0.016, 0, 0)
    expect(p.count).toBe(8)
    p.step(2, 0, 0)
    expect(p.count).toBe(0)
  })
})

describe('round 3', () => {
  it('weapons and shields are solid: a specular-mask alpha is never coverage; binary cut-outs and effect cards stay', async () => {
    const { solidifyWeapon, isWeaponGlb, isCoverage } = await import('../src/three/weapon-solid.ts')
    const { AssetContainer, Material } = await import('@babylonjs/core')
    expect(isWeaponGlb('/out-opt/equipment/china/weapon/spear_03.glb')).toBe(true)
    expect(isWeaponGlb('/out/item/china/shield/shield_04.glb')).toBe(true)
    expect(isWeaponGlb('/out-opt/equipment/china/woman_item/clothes_01_ba.glb')).toBe(false)
    expect(isCoverage({ alphaReason: 'BMT alpha flag; texture alpha mostly binary (21.5% zero, 0.0% partial)' })).toBe(true)
    expect(isCoverage({ alphaReason: 'equipment: BMT alpha test (reference 128) cuts 39% of the surface' })).toBe(false)
    const scene = nullScene()
    const c = new AssetContainer(scene)
    const spear = new PBRMaterial('spear_1_5', scene)
    spear.transparencyMode = Material.MATERIAL_ALPHATEST
    const arrow = new PBRMaterial('cha_arrow', scene)
    arrow.transparencyMode = Material.MATERIAL_ALPHATEST
    c.materials.push(spear, arrow)
    const side = { materials: [{ name: 'spear_1_5', alphaMode: 'MASK' as const, alphaReason: 'equipment: BMT alpha test (reference 128) cuts 39% of the surface' }, { name: 'cha_arrow', alphaMode: 'MASK' as const, alphaReason: 'mostly binary' }] }
    expect(solidifyWeapon(c, '/out-opt/equipment/china/weapon/spear_03.glb', side)).toBe(1)
    expect(spear.transparencyMode).toBe(Material.MATERIAL_OPAQUE)
    expect(arrow.transparencyMode).toBe(Material.MATERIAL_ALPHATEST)
    expect(solidifyWeapon(c, '/out-opt/equipment/china/man_item/x.glb', side)).toBe(0)
  })

  it('a rare spear fires a lance on its hit; other kinds do not', () => {
    const scene = nullScene()
    const rare = new WeaponRarity(scene, { exposure: () => 1 })
    cleanups.push(() => rare.dispose())
    const s = sword(scene)
    const spearOwner = ownerOf(s.owner, true, 'spear')
    rare.light(spearOwner, { meshes: [s.mesh], root: s.root, dummies: s.dummies }, 'sun')
    const b = sword(scene, 3)
    const swordOwner = ownerOf(b.owner, false, 'sword')
    rare.light(swordOwner, { meshes: [b.mesh], root: b.root, dummies: b.dummies }, 'sun')
    const fx = rarityFx(scene)
    fx.frame()
    expect(fx.kindOf(spearOwner)).toBe('spear')
    expect(fx.thrust(spearOwner)).toBe(true)
    expect(fx.thrust(swordOwner)).toBe(false)
  })

  it('a seal shield adds no model: the tier material goes on its own mesh', () => {
    const scene = nullScene()
    const rare = new WeaponRarity(scene, { exposure: () => 1 })
    cleanups.push(() => rare.dispose())
    const s = sword(scene)
    rarityFx(scene) // the effects layer's own batch mesh exists already
    const before = scene.meshes.length
    const it = rare.light(ownerOf(s.owner), { meshes: [s.mesh], root: s.root, dummies: new Map(), slot: 'shield' }, 'moon')!
    expect(scene.meshes.length).toBe(before)
    expect(rare.stateOf(s.mesh)?.item).toBe(it)
    expect(rarityValues(rare.stateOf(s.mesh)!, 1, false)[0]).toBe(RARITY_LOOKS_T.moon.tintAmount)
  })
})

describe('effects on the weapon in an animated pose', () => {
  it('the region base, tip and butt sit on the weapon mesh in world space, posed and turned', () => {
    const scene = nullScene()
    const rare = new WeaponRarity(scene, { exposure: () => 1 })
    cleanups.push(() => rare.dispose())
    const s = sword(scene)
    const o = ownerOf(s.owner, true, 'spear')
    const item = rare.light(o, { meshes: [s.mesh], root: s.root, dummies: s.dummies }, 'sun')!
    for (const [yaw, pitch] of [[0, 0], [1.2, 0.6], [-2.5, -0.9]] as const) {
      s.owner.rotation.set(pitch, yaw, 0.3)
      s.root.rotation.set(-pitch, 0.4, 0)
      s.mesh.computeWorldMatrix(true)
      const w = s.mesh.getWorldMatrix()
      const bb = s.mesh.getBoundingInfo().boundingBox
      bb._update(w)
      for (const p of [item.base, item.tip, item.butt!]) {
        const q = Vector3.TransformCoordinates(p, w)
        expect(q.x).toBeGreaterThanOrEqual(bb.minimumWorld.x - 0.02)
        expect(q.y).toBeGreaterThanOrEqual(bb.minimumWorld.y - 0.02)
        expect(q.z).toBeGreaterThanOrEqual(bb.minimumWorld.z - 0.02)
        expect(q.x).toBeLessThanOrEqual(bb.maximumWorld.x + 0.02)
        expect(q.y).toBeLessThanOrEqual(bb.maximumWorld.y + 0.02)
        expect(q.z).toBeLessThanOrEqual(bb.maximumWorld.z + 0.02)
      }
      // the butt continues the blade's line (not some other direction)
      const b = Vector3.TransformCoordinates(item.base, w)
      const t = Vector3.TransformCoordinates(item.tip, w)
      const u = Vector3.TransformCoordinates(item.butt!, w)
      expect(Vector3.Dot(t.subtract(b).normalize(), b.subtract(u).normalize())).toBeGreaterThan(0.95)
    }
  })
})
