/**
 * P0 crowd rules (docs/CHARACTERS.md §3.3): the outfit merge.
 * - outfit-atlas.ts (pure): the shelf packing (fits, scales down by powers of two, padding, no overlap), the UV checks
 *   and the UV mapping into a rect, the shared key.
 * - crowd-budget.ts planCrowd: an other character beyond OUTFIT_FROM_M in a crowd draws as one outfit mesh; nobody
 *   within it, never the kept ones (own, party, target), not without a crowd, not with the switch off; hysteresis.
 * - CharacterActor.setOutfitMerge (with a stand-in for the GPU atlas): one mesh with every shown part's vertices and
 *   triangles, UVs inside each part's rect, the parts hidden and back again, a part hidden by the dress or by Berserk
 *   left out (the merge is made again), a tiling part left apart, the atlas released.
 */
import {
  Animation,
  AnimationGroup,
  ArcRotateCamera,
  AssetContainer,
  Matrix,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  RawTexture,
  Scene,
  Skeleton,
  TransformNode,
  Vector3,
  VertexBuffer,
  type Mesh,
} from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ATLAS_PAD, atlasKey, packAtlas, remapUV, uvFits } from '../src/three/outfit-atlas.ts'
import type { OutfitAtlas, OutfitAtlases, OutfitPart } from '../src/three/outfit-merge.ts'
import { CharacterActor, ModelLibrary } from '../src/three/models.ts'
import { ANIM_FROM, planCrowd, type CrowdEntry } from '../src/world/crowd-budget.ts'
import { OUTFIT_FROM_M, OUTFIT_HYSTERESIS_M, wantsOutfit } from '../src/world/char-lod.ts'

describe('packAtlas', () => {
  it('packs every texture without overlap, inside the atlas, with the padding around each', () => {
    const plan = packAtlas([{ w: 256, h: 256 }, { w: 128, h: 64 }, { w: 64, h: 128 }, { w: 128, h: 128 }], 512)!
    expect(plan.scale).toBe(1)
    const boxes = plan.rects.map(r => ({ x: r.x - ATLAS_PAD, y: r.y - ATLAS_PAD, w: r.w + 2 * ATLAS_PAD, h: r.h + 2 * ATLAS_PAD }))
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.x + b.w).toBeLessThanOrEqual(512)
      expect(b.y + b.h).toBeLessThanOrEqual(512)
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false)
      }
    expect(plan.rects.map(r => [r.w, r.h])).toEqual([[256, 256], [128, 64], [64, 128], [128, 128]])
  })

  it('scales every texture by the same power of two when they do not fit at full size; null when nothing fits', () => {
    const plan = packAtlas([{ w: 512, h: 512 }, { w: 512, h: 256 }], 512)!
    expect(plan.scale).toBe(0.5)
    expect(plan.rects.map(r => [r.w, r.h])).toEqual([[256, 256], [256, 128]])
    expect(packAtlas([], 512)).toBeNull()
    expect(packAtlas(Array.from({ length: 4000 }, () => ({ w: 64, h: 64 })), 512, 1 / 2)).toBeNull()
  })
})

describe('the atlas UVs', () => {
  it('uvFits takes [0, 1] with a little slack and refuses tiling UVs', () => {
    expect(uvFits([0, 0, 1, 1, 0.5, 1.001, -0.001, 0.2])).toBe(true)
    expect(uvFits([0, 0, 2, 1])).toBe(false)
    expect(uvFits([0, -0.5])).toBe(false)
  })

  it('remapUV maps the unit square onto the inner rect', () => {
    const r = { x: 8, y: 16, w: 128, h: 64 }
    const out = remapUV([0, 0, 1, 1, 0.5, 0.5], r, 512)
    expect([...out]).toEqual([8 / 512, 16 / 512, 136 / 512, 80 / 512, 72 / 512, 48 / 512].map(v => Math.fround(v)))
  })

  it('atlasKey names the textures and their cut-out flags in order', () => {
    expect(atlasKey([{ texture: 3, cutout: true }, { texture: 9, cutout: false }])).toBe('3c|9o')
    expect(atlasKey([{ texture: 9, cutout: false }, { texture: 3, cutout: true }])).not.toBe('3c|9o')
  })
})

describe('planCrowd: the outfit merge', () => {
  const crowd = (n: number, d: number, extra: Partial<CrowdEntry>[] = []): CrowdEntry[] => [
    ...Array.from({ length: n }, () => ({ d, keep: false, wasCasting: false })),
    ...extra.map(e => ({ d: 30, keep: false, wasCasting: false, ...e })),
  ]

  it('beyond OUTFIT_FROM_M in a crowd: one outfit mesh; within it, the kept ones and without a crowd: as before', () => {
    const far = planCrowd(crowd(ANIM_FROM, 30), null, true)
    expect(far.every(d => d.outfit)).toBe(true)
    const near = planCrowd(crowd(ANIM_FROM, OUTFIT_FROM_M - 1), null, true)
    expect(near.some(d => d.outfit)).toBe(false)
    const kept = planCrowd(crowd(ANIM_FROM, 30, [{ keep: true }]), null, true)
    expect(kept.at(-1)!.outfit).toBe(false)
    expect(planCrowd(crowd(ANIM_FROM - 2, 30), null, true).some(d => d.outfit)).toBe(false)
    // the switch off (CHAR_LOD.outfit) and the animation LOD off (Low): nobody
    expect(planCrowd(crowd(ANIM_FROM, 30), null, true, [], false).some(d => d.outfit)).toBe(false)
    expect(planCrowd(crowd(ANIM_FROM, 30), null, false).some(d => d.outfit)).toBe(false)
  })

  it('a merged character stays merged until it is OUTFIT_HYSTERESIS_M nearer than the line', () => {
    const at = OUTFIT_FROM_M - OUTFIT_HYSTERESIS_M / 2
    expect(wantsOutfit(at, false)).toBe(false)
    expect(wantsOutfit(at, true)).toBe(true)
    expect(wantsOutfit(OUTFIT_FROM_M - OUTFIT_HYSTERESIS_M - 0.1, true)).toBe(false)
    const d = planCrowd(crowd(ANIM_FROM, 30, [{ d: at, wasFar: true }, { d: at }]), null, true)
    expect(d.at(-2)!.outfit).toBe(true)
    expect(d.at(-1)!.outfit).toBe(false)
  })
})

// ---- the actor, with a stand-in for the GPU atlas ----

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene)
  const library = new ModelLibrary(scene)
  cleanups.push(() => {
    library.dispose()
    scene.dispose()
    engine.dispose()
  })
  const tex = (n: number) => {
    const t = RawTexture.CreateRGBATexture(new Uint8Array(n * n * 4).fill(255), n, n, scene)
    // NullEngine never finishes an upload: the texture counts as loaded
    t.getInternalTexture()!.isReady = true
    return t
  }
  const pbr = (name: string, t: RawTexture, o: { cut?: boolean; blend?: boolean } = {}) => {
    const m = new PBRMaterial(name, scene)
    m.albedoTexture = t
    if (o.cut) m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    if (o.blend) {
      m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
      m.alpha = 0.5
    }
    return m
  }
  /** Skinned boxes: body + hair (cut out, one texture), cloak (its own texture), veil (blended), rug (tiling UVs). */
  const actor = () => {
    const root = new TransformNode('__root__', scene)
    const skeleton = new Skeleton('skel', 'skel', scene)
    const tA = tex(8)
    const tB = tex(4)
    const matA = pbr('A', tA, { cut: true })
    const matB = pbr('B', tB)
    const matV = pbr('V', tB, { blend: true })
    const part = (pn: string, mat: PBRMaterial, y: number, uvScale = 1) => {
      const m = MeshBuilder.CreateBox(pn, { width: 0.5, height: 0.5, depth: 0.5 }, scene)
      m.bakeTransformIntoVertices(Matrix.Translation(0, y, 0))
      const n = m.getTotalVertices()
      m.setVerticesData(VertexBuffer.MatricesIndicesKind, new Array(n * 4).fill(0), false, 4)
      m.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), false, 4)
      if (uvScale !== 1) m.setVerticesData(VertexBuffer.UVKind, m.getVerticesData(VertexBuffer.UVKind)!.map(v => v * uvScale))
      m.material = mat
      m.skeleton = skeleton
      m.parent = root
      return m
    }
    const meshes = [part('body', matA, 1), part('hair', matA, 1.9), part('cloak', matB, 1.2), part('veil', matV, 1.6), part('rug', matB, 0.2, 3)]
    const c = new AssetContainer(scene)
    c.transformNodes.push(root)
    c.meshes.push(...meshes)
    c.skeletons.push(skeleton)
    c.materials.push(matA, matB, matV)
    c.animationGroups.push(new AnimationGroup('STAND1', scene))
    c.removeAllFromScene()
    const a = new CharacterActor(scene, { code: 'CHAR_TEST', glb: '/out/t.glb' }, { container: c, sidecar: null, packs: null })
    // the GPU atlas stand-in: a 64² plan with one rect per texture
    const made: OutfitAtlas[] = []
    let live = 0
    const fake = {
      acquire(parts: readonly OutfitPart[]) {
        const slot = new Map<number, number>()
        for (const p of parts) if (!slot.has(p.texture.uniqueId)) slot.set(p.texture.uniqueId, slot.size)
        const rects = [...slot.keys()].map((_, i) => ({ x: 4 + i * 24, y: 4, w: 16, h: 16 }))
        const atlas = { key: 'k', plan: { size: 64, scale: 1, rects }, slot, material: new PBRMaterial('atlas', scene), users: 1 } as unknown as OutfitAtlas
        made.push(atlas)
        live++
        return atlas
      },
      release() {
        live--
      },
    } as unknown as OutfitAtlases
    a.outfitSource = () => fake
    const get = (n: string) => a.meshes.find(m => m.name === n) as Mesh
    return { a, get, made, live: () => live }
  }
  return { scene, actor }
}

describe('CharacterActor.setOutfitMerge', () => {
  it('one mesh with the shown parts of the actor skeleton, UVs in their rects; blended and tiling parts stay apart', () => {
    const { actor } = setup()
    const { a, get, made, live } = actor()
    const v = a.mergeVersion
    expect(a.setOutfitMerge(true)).toBe(true)
    expect(a.outfitMerged).toBe(true)
    expect(a.mergeVersion).toBeGreaterThan(v)
    const info = a.outfitInfo!
    expect(info.parts.map(p => p.name)).toEqual(['body', 'hair', 'cloak'])
    const mesh = info.mesh as Mesh
    expect(mesh.getTotalVertices()).toBe(3 * get('body').getTotalVertices())
    expect(mesh.getTotalIndices()).toBe(3 * get('body').getTotalIndices())
    expect(mesh.skeleton).toBe(get('body').skeleton)
    expect(mesh.material).toBe(made[0]!.material)
    for (const n of ['body', 'hair', 'cloak']) expect(get(n).isEnabled()).toBe(false)
    expect(get('veil').isEnabled()).toBe(true)
    expect(get('rug').isEnabled()).toBe(true)
    // body and hair share texture A: rect 0 (x 4..20 of 64); the cloak rect 1 (x 28..44)
    const uv = mesh.getVerticesData(VertexBuffer.UVKind)!
    const n = get('body').getTotalVertices()
    for (let i = 0; i < 2 * n * 2; i += 2) expect(uv[i]! * 64).toBeGreaterThanOrEqual(4 - 1e-4)
    for (let i = 0; i < 2 * n * 2; i += 2) expect(uv[i]! * 64).toBeLessThanOrEqual(20 + 1e-4)
    for (let i = 2 * n * 2; i < 3 * n * 2; i += 2) expect(uv[i]! * 64).toBeGreaterThanOrEqual(28 - 1e-4)
    expect(a.allMeshes()).toContain(mesh)
    expect(live()).toBe(1)
    // same parts: nothing to do
    expect(a.setOutfitMerge(true)).toBe(false)
    // off: the parts come back, the mesh and the atlas go
    a.setOutfitMerge(false)
    expect(a.outfitMerged).toBe(false)
    expect(mesh.isDisposed()).toBe(true)
    for (const n of ['body', 'hair', 'cloak']) expect(get(n).isEnabled()).toBe(true)
    expect(live()).toBe(0)
  })

  it('a part hidden later (Berserk hides the hair) is left out of a new merge; opacity and the cull reach the mesh', () => {
    const { actor } = setup()
    const { a, get } = actor()
    a.setOpacity(0.5)
    a.setOutfitMerge(true)
    expect((a.outfitInfo!.mesh as Mesh).visibility).toBe(0.5)
    get('hair').isVisible = false
    // within OUTFIT_RECHECK_MS the merge is not checked again; past it, it is made again without the hair
    expect(a.setOutfitMerge(true)).toBe(false)
    const t = performance.now() + 5000
    const spy = vi.spyOn(performance, 'now').mockReturnValue(t)
    expect(a.setOutfitMerge(true)).toBe(true)
    spy.mockRestore()
    expect(a.outfitInfo!.parts.map(p => p.name)).toEqual(['body', 'cloak'])
    a.setOffscreen(true)
    expect(a.outfitInfo!.mesh.alwaysSelectAsActiveMesh).toBe(false)
  })

  it('without an atlas source, or disposed, nothing is merged; disposing releases the atlas', () => {
    const { actor } = setup()
    const { a, live } = actor()
    a.setOutfitMerge(true)
    expect(live()).toBe(1)
    a.dispose()
    expect(live()).toBe(0)
    expect(a.setOutfitMerge(true)).toBe(false)
    const b = actor().a
    b.outfitSource = null
    expect(b.setOutfitMerge(true)).toBe(false)
  })
})

describe('the far clip snap', () => {
  it('planCrowd marks the far characters (outfit merge or not); the near and the kept ones are not far', () => {
    const e = (d: number, keep = false): CrowdEntry => ({ d, keep, wasCasting: false })
    const out = planCrowd([...Array.from({ length: ANIM_FROM }, () => e(30)), e(5), e(30, true)], null, true, [], false)
    expect(out.slice(0, ANIM_FROM).every(d => d.far && !d.outfit)).toBe(true)
    expect(out.at(-2)!.far).toBe(false)
    expect(out.at(-1)!.far).toBe(false)
  })

  it('an actor with snapClips starts its clips without the blend, and a blend does not hold it at every frame', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const root = new TransformNode('__root__', scene)
    const joint = new TransformNode('J', scene)
    joint.parent = root
    const c = new AssetContainer(scene)
    c.transformNodes.push(root, joint)
    const groups = ['STAND1', 'RUN'].map(name => {
      const anim = new Animation(`${name}_x`, 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
      anim.setKeys([
        { frame: 0, value: new Vector3(0, 0, 0) },
        { frame: 30, value: new Vector3(name === 'RUN' ? 5 : 1, 0, 0) },
      ])
      const g = new AnimationGroup(name, scene)
      g.addTargetedAnimation(anim, joint)
      c.animationGroups.push(g)
      return g
    })
    c.removeAllFromScene()
    const a = new CharacterActor(scene, { code: 'MOB_TEST', glb: '/out/s.glb' }, { container: c, sidecar: null, packs: null })
    a.play('STAND1')
    scene.render()
    a.snapClips = true
    a.play('RUN')
    const run = a.group('RUN')!
    const ra = run.animatables[0]!.getAnimations()[0] as unknown as { _enableBlending: boolean }
    expect(ra._enableBlending).toBe(false)
    // the shared animations keep their own blending flag
    expect(groups[1]!.targetedAnimations[0]!.animation.enableBlending).toBe(run.enableBlending)
    a.snapClips = false
    a.play('STAND1')
    const st = a.group('STAND1')!.animatables[0]!.getAnimations()[0] as unknown as { _enableBlending: boolean }
    expect(st._enableBlending).toBe(a.group('STAND1')!.enableBlending)
  })
})
