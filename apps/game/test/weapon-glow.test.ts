/**
 * The alchemy glow on weapons (three/weapon-glow.ts): the tier table (each + level → its tier, open-ended), the mode
 * per preset (Low/Classic → the lite code, no glints; the glint cap per preset), the material plugin's code in both
 * shader languages (the same injection point, a point of Babylon 9.28's PBR fragment in both, only names those
 * shaders have, no GLSL in the WGSL), the plugin on a NullEngine PBRMaterial (per-mesh defines on a shared material,
 * per-draw values, the lite define on Low, the processed fragment), the exposure scale, the +7 glints (cap, own
 * character first, range, one batch), and the actor plumbing (applyDress lights the hung weapon by Look.plus,
 * setPlus re-lights it, an appearance with the same codes only re-lights).
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
import type { EntityState } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { CharacterActor } from '../src/three/models.ts'
import {
  GLINT_CAPS,
  GLINT_RANGE_M,
  GLINTS_PER_RUN,
  GLOW_DEFINES,
  GLOW_UNIFORMS,
  LITE_GAIN,
  NOON_EXPOSURE,
  RETAIL_BLUE,
  SHIELD_STRENGTH,
  WEAPON_GLOW_PLUGIN,
  WEAPON_GLOW_TIERS,
  WeaponGlow,
  bandAt,
  exposureScale,
  glintCurve,
  glowModeFor,
  glowTierFor,
  glowValues,
  pickGlinting,
  weaponGlowCode,
  weaponGlowPluginOf,
  type GlowMode,
  type GlowOwner,
  type ItemGlow,
} from '../src/three/weapon-glow.ts'
import { EntityView, sameCodesOf, type EntityContext } from '../src/world/entities.ts'

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

/** The PBR fragment of one language with every include appended (the texts the injection points live in). */
function pbrSources(lang: 'wgsl' | 'glsl'): string {
  const main = lang === 'wgsl' ? ShaderStore.ShadersStoreWGSL.pbrPixelShader : ShaderStore.ShadersStore.pbrPixelShader
  const includes = lang === 'wgsl' ? ShaderStore.IncludesShadersStoreWGSL : ShaderStore.IncludesShadersStore
  expect(main, `pbr fragment (${lang})`).toBeTruthy()
  return [main, ...Object.values(includes)].join('\n')
}

/** Prepares the defines and waits for the (NullEngine) effect. */
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

/** A sword-like item: a long box along +Z under its own root, with the blade dummies of sword_01's sidecar. */
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

// ---- the tier table ---------------------------------------------------------------------------------------------

describe('tier table', () => {
  it('maps each + level from +1 to +7 to its own row, +0 to none, and +8 … to the last row (open-ended)', () => {
    expect(glowTierFor(0)).toBeNull()
    expect(glowTierFor(undefined)).toBeNull()
    expect(glowTierFor(-1)).toBeNull()
    for (let n = 1; n <= 7; n++) expect(glowTierFor(n)?.plus, `+${n}`).toBe(n)
    for (const n of [8, 10, 12, 255]) expect(glowTierFor(n)?.plus, `+${n}`).toBe(7)
    // Rows rise; a row added for +8 takes over +8 without code changes.
    expect(WEAPON_GLOW_TIERS.map(t => t.plus)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const more = [...WEAPON_GLOW_TIERS, { ...WEAPON_GLOW_TIERS[6]!, plus: 8, glow: 1 }]
    expect(glowTierFor(8, more)?.glow).toBe(1)
    expect(glowTierFor(9, more)?.plus).toBe(8)
    expect(glowTierFor(7, more)?.plus).toBe(7)
  })

  it('grows with the + level: a shimmer first, colour from +3, a pulse from +5, glints only at +7', () => {
    const t = (n: number) => glowTierFor(n)!
    expect([t(1).glow, t(1).rim]).toEqual([0, 0])
    expect(t(1).shimmer).toBeGreaterThan(0)
    for (let n = 2; n <= 7; n++) {
      expect(t(n).glow, `glow +${n}`).toBeGreaterThan(t(n - 1).glow)
      expect(t(n).rim, `rim +${n}`).toBeGreaterThan(t(n - 1).rim)
      expect(t(n).shimmer, `shimmer +${n}`).toBeGreaterThan(t(n - 1).shimmer)
      expect(t(n).sweepS, `sweep +${n}`).toBeLessThanOrEqual(t(n - 1).sweepS)
    }
    expect([1, 2].map(n => t(n).color)).not.toContain(RETAIL_BLUE)
    expect([3, 4, 5, 6].every(n => t(n).color === RETAIL_BLUE)).toBe(true)
    expect([1, 2, 3, 4].every(n => t(n).pulse === 0)).toBe(true)
    expect([5, 6, 7].every(n => t(n).pulse > 0)).toBe(true)
    expect(WEAPON_GLOW_TIERS.filter(r => r.glints > 0).map(r => r.plus)).toEqual([7])
  })
})

describe('mode per preset', () => {
  it('Low (Classic) draws the lite code and no glints; the PBR presets cap the glints', () => {
    expect(glowModeFor({ render: 'classic', renderPreset: 'low' })).toEqual({ lite: true, glintCap: 0 })
    expect(glowModeFor({ render: 'pbr', renderPreset: 'medium' })).toEqual({ lite: false, glintCap: GLINT_CAPS.medium })
    expect(glowModeFor({ render: 'pbr', renderPreset: 'high' })).toEqual({ lite: false, glintCap: GLINT_CAPS.high })
    expect(glowModeFor({ render: 'pbr', renderPreset: 'ultra' })).toEqual({ lite: false, glintCap: GLINT_CAPS.ultra })
    expect(GLINT_CAPS.medium).toBeGreaterThan(0)
    expect(GLINT_CAPS.ultra).toBeLessThanOrEqual(8)
  })

  it('divides the display-relative values by the post exposure (1 on Classic), lifting them a little at night', () => {
    expect(exposureScale(1)).toBe(1)
    expect(exposureScale(0)).toBe(1)
    expect(exposureScale(NOON_EXPOSURE)).toBeCloseTo(1 / NOON_EXPOSURE, 9)
    const night = 30
    expect(exposureScale(night) * night).toBeGreaterThan(1)
    expect(exposureScale(night) * night).toBeLessThan(1.2)
  })
})

// ---- the shader code ----------------------------------------------------------------------------------------------

describe('plugin code', () => {
  it('ships the same injection point in WGSL and GLSL, a PBR fragment point in both languages', () => {
    const wgsl = weaponGlowCode('wgsl')
    const glsl = weaponGlowCode('glsl')
    expect(Object.keys(wgsl)).toEqual(['CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION'])
    expect(Object.keys(glsl)).toEqual(Object.keys(wgsl))
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = pbrSources(lang)
      for (const point of Object.keys(wgsl)) expect(src.includes(`#define ${point}`), `${lang} ${point}`).toBe(true)
    }
  })

  it('only names what the PBR fragment has at that point, in both languages; no varying of its own', () => {
    for (const n of ['finalEmissive', 'normalW', 'viewDirectionW', 'vPositionW', 'surfaceAlbedo']) {
      for (const lang of ['wgsl', 'glsl'] as const) expect(pbrSources(lang).includes(n), `${lang} ${n}`).toBe(true)
    }
    // The mesh's world matrix: the mesh uniform block, declared in the fragment of both languages.
    expect(ShaderStore.IncludesShadersStoreWGSL.meshUboDeclaration).toMatch(/var<uniform>\s+mesh\s*:\s*Mesh/)
    expect(ShaderStore.IncludesShadersStoreWGSL.pbrUboDeclaration).toContain('#include<meshUboDeclaration>')
    expect(ShaderStore.IncludesShadersStore.meshUboDeclaration).toMatch(/mat4 world/)
    expect(ShaderStore.IncludesShadersStore.pbrUboDeclaration).toContain('#include<meshUboDeclaration>')
    expect(weaponGlowCode('wgsl').CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toContain('mesh.world')
    expect(weaponGlowCode('glsl').CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toMatch(/\bworld \*/)
    for (const lang of ['wgsl', 'glsl'] as const) expect(weaponGlowCode(lang).CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).not.toMatch(/\bvarying\b|@location/)
  })

  it('has no GLSL idiom in the WGSL and no WGSL idiom in the GLSL; every #if is closed; all under SROGLOW', () => {
    const wgsl = weaponGlowCode('wgsl').CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION!
    const glsl = weaponGlowCode('glsl').CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION!
    expect(wgsl).not.toMatch(/\b(float|vec[234]|texture2D|dFdx|dFdy|gl_\w+)\s*[(\s]/)
    expect(wgsl).not.toMatch(/\?[^:]*:/)
    expect(wgsl).not.toMatch(/[^=!<>+\-*/]\+=|\*=/) // compound assignment kept out (older Tint builds)
    expect(glsl).not.toMatch(/\b(fn|let|var)\s|vec[234]f\(|fragmentInputs|uniforms\./)
    for (const code of [wgsl, glsl]) {
      expect((code.match(/^#if/gm) ?? []).length).toBe((code.match(/^#endif/gm) ?? []).length)
      expect(code.trim().startsWith('#ifdef SROGLOW\n')).toBe(true)
    }
    // The lite branch (Low) reads neither the world matrix nor the normal: two terms of uniforms.
    for (const code of [wgsl, glsl]) {
      const lite = code.slice(code.indexOf('#ifdef SROGLOW_LITE'), code.indexOf('#else'))
      expect(lite).not.toMatch(/world|normalW|vPositionW|smoothstep|exp2/)
      for (const u of GLOW_UNIFORMS.filter(n => /C|S|K/.test(n.slice(-1)))) expect(code).toContain(u)
    }
  })
})

// ---- the plugin on a material --------------------------------------------------------------------------------------

describe('WeaponGlowPlugin on a NullEngine PBRMaterial', () => {
  it('goes on once per material; a glowing mesh turns SROGLOW on for itself only, Low turns on the lite code', async () => {
    const scene = nullScene()
    let mode: GlowMode = { lite: false, glintCap: 4 }
    const glow = new WeaponGlow(scene, { mode: () => mode, now: () => 10, exposure: () => 1 })
    cleanups.push(() => glow.dispose())
    const mat = new PBRMaterial('sword1_2_3', scene)
    const a = sword(scene, mat, 'a')
    const b = sword(scene, mat, 'b') // another actor's copy of the same model: the shared glTF material
    glow.prepare([a.mesh, b.mesh])
    glow.prepare([a.mesh])
    expect(mat.pluginManager?.getPlugin(WEAPON_GLOW_PLUGIN)).toBe(weaponGlowPluginOf(mat))
    expect(weaponGlowPluginOf(mat)).not.toBeNull()
    expect(await ready(a.mesh)).toBe(true)
    expect(await ready(b.mesh)).toBe(true)
    expect([definesOf(a.mesh).SROGLOW, definesOf(b.mesh).SROGLOW]).toEqual([false, false])

    const item = glow.light(owner(scene), { meshes: [a.mesh], root: a.root, dummies: a.dummies }, 5)!
    expect(item.tier.plus).toBe(5)
    expect(item.blade).toBe(true)
    expect(item.length).toBeCloseTo(Vector3.Distance(a.dummies.get('ai_start')!, a.dummies.get('ai_end')!), 6)
    expect(await ready(a.mesh)).toBe(true)
    expect(await ready(b.mesh)).toBe(true)
    expect([definesOf(a.mesh).SROGLOW, definesOf(a.mesh).SROGLOW_LITE, definesOf(b.mesh).SROGLOW]).toEqual([true, false, false])
    // The glowing mesh draws its own effect (its defines carry SROGLOW); the plugin's code is in the material's shader.
    const effect = (m: Mesh) => m.subMeshes[0]!.effect!
    const defs = (m: Mesh) => effect(m).defines
    expect(defs(a.mesh)).toMatch(/#define SROGLOW\b/)
    expect(defs(a.mesh)).not.toMatch(/#define SROGLOW_LITE\b/)
    expect(defs(b.mesh)).not.toMatch(/#define SROGLOW\b/)
    expect(effect(a.mesh)).not.toBe(effect(b.mesh))
    const frag = (effect(a.mesh) as unknown as { _fragmentSourceCode?: string })._fragmentSourceCode ?? ''
    if (frag) expect(frag).toContain('sgBand')

    // Low: the lite code on the next frame (defines are re-read every frame).
    mode = { lite: true, glintCap: 0 }
    glow.frame()
    expect(await ready(a.mesh)).toBe(true)
    expect([definesOf(a.mesh).SROGLOW, definesOf(a.mesh).SROGLOW_LITE]).toEqual([true, true])
    expect(defs(a.mesh)).toMatch(/#define SROGLOW_LITE\b/)

    // +0 clears it; disposing a glowing mesh clears it too.
    glow.light(owner(scene), { meshes: [a.mesh], root: a.root, dummies: a.dummies }, 0)
    expect(glow.stateOf(a.mesh)).toBeNull()
    expect(await ready(a.mesh)).toBe(true)
    expect(definesOf(a.mesh).SROGLOW).toBe(false)
    glow.light(owner(scene), { meshes: [b.mesh], root: b.root, dummies: b.dummies }, 7)
    expect(glow.live.size).toBe(1)
    b.mesh.dispose()
    expect(glow.live.size).toBe(0)
    expect(Object.keys(GLOW_DEFINES)).toEqual(['SROGLOW', 'SROGLOW_LITE'])
  })

  it('writes each mesh its own values on every draw (two + levels on one shared material)', () => {
    const scene = nullScene()
    const glow = new WeaponGlow(scene, { now: () => 3, exposure: () => 1 })
    cleanups.push(() => glow.dispose())
    const mat = new PBRMaterial('shared', scene)
    const a = sword(scene, mat, 'a')
    const b = sword(scene, mat, 'b')
    glow.light(owner(scene), { meshes: [a.mesh], root: a.root, dummies: a.dummies }, 2)
    glow.light(owner(scene), { meshes: [b.mesh], root: b.root, dummies: b.dummies }, 7)
    const plugin = weaponGlowPluginOf(mat)!
    const written = (m: Mesh) => {
      const calls: Record<string, number[]> = {}
      const ubo = { updateFloat4: (n: string, x: number, y: number, z: number, w: number) => void (calls[n] = [x, y, z, w]) } as unknown as UniformBuffer
      plugin.hardBindForSubMesh(ubo, scene, scene.getEngine(), m.subMeshes[0]!)
      return calls
    }
    const wa = written(a.mesh)
    const wb = written(b.mesh)
    expect(Object.keys(wa).sort()).toEqual([...GLOW_UNIFORMS].sort())
    // K.x (the steady glow) and K.w (the rim) follow each mesh's tier.
    expect(wa.sroGlowK![0]).toBeCloseTo(glowTierFor(2)!.glow, 6)
    expect(wb.sroGlowK![3]).toBeGreaterThan(wa.sroGlowK![3]!)
    // A mesh without glow writes nothing (its draw does not read them).
    const c = sword(scene, mat, 'c')
    expect(Object.keys(written(c.mesh))).toEqual([])
  })

  it('puts the blade axis in each mesh\'s own space (a quantized mesh with a node scale) and falls back to the box', () => {
    const scene = nullScene()
    const glow = new WeaponGlow(scene, { exposure: () => 1 })
    cleanups.push(() => glow.dispose())
    const s = sword(scene)
    s.mesh.scaling.setAll(0.42)
    s.mesh.position.set(0.1, 0, 0.3)
    glow.light(owner(scene), { meshes: [s.mesh], root: s.root, dummies: s.dummies }, 3)
    const g = glow.stateOf(s.mesh)!
    const toItem = (p: Vector3) => Vector3.TransformCoordinates(p, s.mesh.computeWorldMatrix(true)).subtract(s.root.getAbsolutePosition())
    expect(toItem(g.origin).subtract(s.dummies.get('ai_start')!).length()).toBeLessThan(1e-5)
    expect(toItem(g.origin.add(g.axis)).subtract(s.dummies.get('ai_end')!).length()).toBeLessThan(1e-5)
    // A shield (no blade dummies): the longest side of its box, whole item unmasked.
    const shield = MeshBuilder.CreateBox('shield', { width: 0.5, height: 0.7, depth: 0.05 }, scene)
    const root = new TransformNode('shield:root', scene)
    shield.parent = root
    shield.material = new PBRMaterial('shield', scene)
    const item = glow.light(owner(scene), { meshes: [shield], root, dummies: new Map(), strength: SHIELD_STRENGTH }, 7)!
    expect(item.blade).toBe(false)
    expect(item.length).toBeCloseTo(0.7, 5)
    expect(item.strength).toBe(SHIELD_STRENGTH)
    const sg = glow.stateOf(shield)!
    expect(Math.abs(sg.axis.y)).toBeCloseTo(0.7, 5)
    expect(sg.mask[0]).toBeLessThan(-0.4)
  })
})

describe('uniform values', () => {
  const item = (plus: number, strength = 1): ItemGlow => {
    const tier = glowTierFor(plus)!
    return { owner: null as unknown as GlowOwner, tier, color: { r: 0.3, g: 0.3, b: 1 } as never, shimmerColor: { r: 0.7, g: 1, b: 1 } as never, meshes: [], phase: 0, strength, base: Vector3.Zero(), tip: Vector3.Forward(), length: 1, blade: true }
  }
  const mesh = (plus: number, strength = 1) => ({ item: item(plus, strength), origin: Vector3.Zero(), axis: new Vector3(0, 0, 1), mask: [-0.35, -0.02, 1.15, 1.3] as const })

  it('full: glow, shimmer, the band centre and the rim; the band sweeps the blade then rests off it', () => {
    const v = glowValues(mesh(7), 0.2, false)
    const t = glowTierFor(7)!
    expect(v[21]).toBeCloseTo(t.shimmer, 6)
    expect(v[22]).toBeGreaterThan(-0.3)
    expect(v[22]).toBeLessThan(1.3)
    // The band crosses in SWEEP_SHARE of the sweep, then sits far away (no shimmer between sweeps).
    expect(bandAt(t, t.sweepS * 0.9, 0)).toBeGreaterThan(10)
    expect(bandAt(t, 0, 0)).toBeCloseTo(-0.25, 6)
    // Shields glow at their strength; the exposure scale divides everything.
    expect(glowValues(mesh(7, SHIELD_STRENGTH), 0.2, false)[23]).toBeCloseTo(v[23]! * SHIELD_STRENGTH, 6)
    expect(glowValues(mesh(7), 0.2, false, 0.1)[20]).toBeCloseTo(v[20]! * 0.1, 6)
  })

  it('lite (Low): two terms only, no band or rim, at LITE_GAIN of the full values', () => {
    const t = glowTierFor(4)!
    const v = glowValues(mesh(4), 0.5, true)
    expect([v[22], v[23]]).toEqual([0, 0])
    expect(v[20]).toBeGreaterThan(0)
    expect(v[20]).toBeLessThanOrEqual((t.glow + t.rim) * LITE_GAIN)
    // +1 has no steady glow in either path.
    expect(glowValues(mesh(1), 0.5, true)[20]).toBe(0)
  })
})

// ---- the +7 glints ---------------------------------------------------------------------------------------------------

describe('glints (+7)', () => {
  it('picks your own first, then the nearest on screen in range, at most the cap; never below +7', () => {
    const scene = nullScene()
    const glow = new WeaponGlow(scene, { exposure: () => 1 })
    cleanups.push(() => glow.dispose())
    const add = (plus: number, x: number, self = false, offscreen = false) => {
      const s = sword(scene, undefined, `w${x}`)
      const o = owner(scene, self, offscreen)
      o.root.position.x = x
      return glow.light(o, { meshes: [s.mesh], root: s.root, dummies: s.dummies }, plus)!
    }
    const far = add(7, GLINT_RANGE_M + 5)
    const near2 = add(7, 6)
    const near1 = add(7, 3)
    const six = add(6, 1)
    const hidden = add(7, 2, false, true)
    const me = add(7, GLINT_RANGE_M + 50, true)
    const eye = Vector3.Zero()
    const pick = pickGlinting(glow.live, 4, eye)
    expect(pick[0]).toBe(me)
    expect(pick).toEqual([me, near1, near2])
    expect(pick).not.toContain(far)
    expect(pick).not.toContain(six)
    expect(pick).not.toContain(hidden)
    expect(pickGlinting(glow.live, 2, eye)).toEqual([me, near1])
    expect(pickGlinting(glow.live, 0, eye)).toEqual([])
    // A hidden weapon (Hide Weapon) shows none.
    near1.meshes[0]!.isVisible = false
    expect(pickGlinting(glow.live, 4, eye)).toEqual([me, near2])
  })

  it('draws every chosen run in one batch, within the cap, and nothing on Low', () => {
    const scene = nullScene()
    let mode: GlowMode = { lite: false, glintCap: 2 }
    let t = 0
    const glow = new WeaponGlow(scene, { mode: () => mode, now: () => t, exposure: () => 1 })
    cleanups.push(() => glow.dispose())
    for (let i = 0; i < 5; i++) {
      const s = sword(scene, undefined, `g${i}`)
      glow.light(owner(scene), { meshes: [s.mesh], root: s.root, dummies: s.dummies }, 7)
    }
    const batch = glow.glints!
    expect(batch).not.toBeNull()
    let most = 0
    for (t = 0; t < 2; t += 0.05) {
      glow.frame()
      expect(batch.shown.length).toBe(2)
      most = Math.max(most, batch.drawn)
      expect(batch.drawn).toBeLessThanOrEqual(2 * GLINTS_PER_RUN * 2)
    }
    expect(most).toBeGreaterThan(0)
    expect(scene.meshes.filter(m => m.name === 'weaponGlints')).toHaveLength(1)
    mode = { lite: true, glintCap: 0 }
    glow.frame()
    expect([batch.drawn, batch.mesh.isVisible]).toEqual([0, false])
  })

  it('a burst flares and fades within its life', () => {
    expect(glintCurve(-0.1).alpha).toBe(0)
    expect(glintCurve(1).alpha).toBe(0)
    expect(glintCurve(0.3).alpha).toBeGreaterThan(glintCurve(0.05).alpha)
    expect(glintCurve(0.3).alpha).toBeGreaterThan(glintCurve(0.9).alpha)
    expect(glintCurve(0.6).size).toBeGreaterThan(glintCurve(0).size)
  })
})

// ---- the actor --------------------------------------------------------------------------------------------------------

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
  const mesh = MeshBuilder.CreateBox('sword_01', { width: 0.06, height: 0.02, depth: 0.9 }, scene)
  mesh.parent = root
  const mat = new PBRMaterial('sword1_2_3', scene)
  mesh.material = mat
  // Only the sword (moveAllFromScene would take the actors already in the scene too).
  const c = new AssetContainer(scene)
  c.transformNodes.push(root)
  c.meshes.push(mesh)
  c.materials.push(mat)
  c.removeAllFromScene()
  return c
}

const SWORD_SIDECAR = { dummies: { ai_start: [-0.008, 0, 0.101], ai_end: [-0.013, 0, 0.759] } }

/** As ModelLibrary.dress: a new dress token (unless `begun`: the dress started earlier), then applyDress. */
function dressWith(actor: CharacterActor, container: AssetContainer, plus: Record<string, number> | undefined, begun = false): void {
  if (!begun) actor.beginDress()
  actor.applyDress({
    comp: null,
    items: [{ item: { code: 'ITEM_CH_SWORD_01_A', slot: 'weapon', kind: 'socket', glb: '/out/sword_01.glb', attachBone: HAND } as never, container, sidecar: SWORD_SIDECAR }],
    fallback: null,
    family: 'sword',
    gender: 'male',
    volume: undefined,
    plus,
  } as Parameters<CharacterActor['applyDress']>[0])
}

/** EntityView's label needs a DOM element (as abuse-7b-fx.test.ts / seams-fx.test.ts). */
class StubElement {
  className = ''
  textContent = ''
  hidden = false
  readonly style: Record<string, string> = {}
  readonly children: StubElement[] = []
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(' ').includes(c)
      const want = on ?? !has
      if (want && !has) this.className = `${this.className} ${c}`.trim()
      if (!want && has) this.className = this.className.split(' ').filter(x => x !== c).join(' ')
      return want
    },
    add: (c: string) => void this.classList.toggle(c, true),
    remove: (c: string) => void this.classList.toggle(c, false),
    contains: (c: string) => this.className.split(' ').includes(c),
  }
  append(...c: unknown[]): void {
    for (const x of c) if (x instanceof StubElement) this.children.push(x)
  }
  insertBefore(c: StubElement): void {
    this.children.unshift(c)
  }
  remove(): void {}
}

describe('actor plumbing', () => {
  it('applyDress lights the hung weapon by Look.plus; setPlus re-lights it without re-dressing; +0 clears', () => {
    const scene = nullScene()
    const glow = new WeaponGlow(scene, { exposure: () => 1 })
    cleanups.push(() => glow.dispose())
    const actor = playerActor(scene)
    actor.glow = glow
    const sw = swordContainer(scene)
    dressWith(actor, sw, { weapon: 4 })
    const [item] = [...glow.live]
    expect(item?.tier.plus).toBe(4)
    expect(item?.owner).toBe(actor)
    expect(item?.blade).toBe(true)
    const mesh = item!.meshes[0]!
    expect(weaponGlowPluginOf(mesh.material)).not.toBeNull()
    expect(actor.plus).toEqual({ weapon: 4 })
    actor.setPlus({ weapon: 7 })
    expect([...glow.live].map(i => [i.tier.plus, i.meshes[0]])).toEqual([[7, mesh]])
    actor.setPlus(undefined)
    expect(glow.live.size).toBe(0)
    // A re-dress keeps the plan's +N, unless a setPlus came while it loaded.
    dressWith(actor, sw, { weapon: 2 })
    expect([...glow.live][0]?.tier.plus).toBe(2)
    actor.beginDress()
    actor.setPlus({ weapon: 6 })
    dressWith(actor, sw, { weapon: 2 }, true)
    expect([...glow.live][0]?.tier.plus).toBe(6)
    // The next dress (begun after that setPlus) takes its own look again.
    dressWith(actor, sw, { weapon: 3 })
    expect([...glow.live][0]?.tier.plus).toBe(3)
    actor.dispose()
    expect(glow.live.size).toBe(0)
  })

  it('an appearance with the same codes only re-lights the weapon (no re-dress); new codes re-dress', async () => {
    const scene = nullScene()
    const glow = new WeaponGlow(scene, { exposure: () => 1 })
    cleanups.push(() => glow.dispose())
    const actor = playerActor(scene)
    actor.glow = glow
    dressWith(actor, swordContainer(scene), undefined)
    const dressed: unknown[] = []
    const state: EntityState = { id: 9, kind: 'player', name: 'Other', model: 'CHAR_CH_MAN_ADVENTURER', level: 10, weapon: 'sword', pos: [0, 0, 0], yaw: 0, equip: { weapon: 'ITEM_CH_SWORD_01_A' } }
    const ctx = {
      scene,
      library: { dress: (_a: unknown, look: unknown) => (dressed.push(look), Promise.resolve()) },
      catalog: { weapon: () => undefined, item: () => undefined },
      labels: new StubElement(),
      drops: null,
      heightAt: () => 0,
      selfId: () => 1,
      selfLevel: () => 5,
      serverNow: () => 0,
      attachments: [],
    } as unknown as EntityContext
    const hadDocument = 'document' in globalThis
    if (!hadDocument) (globalThis as { document?: unknown }).document = { createElement: () => new StubElement() }
    const view = new EntityView(state, ctx)
    // Before the engine's dispose (it unhooks document listeners when a document exists).
    cleanups.unshift(() => {
      view.dispose()
      if (!hadDocument) delete (globalThis as { document?: unknown }).document
    })
    view.actor = actor
    await view.setEquip({ weapon: 'ITEM_CH_SWORD_01_A' }, { weapon: 7 })
    expect(dressed).toHaveLength(0)
    expect(view.state.equipPlus).toEqual({ weapon: 7 })
    expect([...glow.live][0]?.tier.plus).toBe(7)
    await view.setEquip({ weapon: 'ITEM_CH_SWORD_01_A' }, undefined)
    expect(view.state.equipPlus).toBeUndefined()
    expect(glow.live.size).toBe(0)
    await view.setEquip({ weapon: 'ITEM_CH_BLADE_01_A' }, { weapon: 3 })
    expect(dressed).toHaveLength(1)
    expect((dressed[0] as { plus?: unknown }).plus).toEqual({ weapon: 3 })
    expect(sameCodesOf({ weapon: 'A', chest: 'B' }, { chest: 'B', weapon: 'A' })).toBe(true)
    expect(sameCodesOf({ weapon: 'A' }, { weapon: 'A', shield: 'S' })).toBe(false)
  })
})
