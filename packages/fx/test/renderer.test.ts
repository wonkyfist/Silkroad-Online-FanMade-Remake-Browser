/**
 * NullEngine smoke test: an effect with a plate, a mesh and a pipe node plays in a right-handed Babylon scene,
 * builds geometry every frame and cleans up. With the exported client effects present (work/out/fx, written by
 * packages/convert/src/tools/export-fx.ts) it also plays a few real Chinese skill effects end to end.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArcRotateCamera, NullEngine, Scene, TransformNode, Vector3, VertexBuffer, type Mesh } from '@babylonjs/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FX_FORMAT, FX_FPS, FX_VERSION, FxInstance, FxLibrary, nodePose, type FxEffect, type FxNode } from '../src/index.ts'

const OUT = join(import.meta.dirname, '../../../work/out')

const LINK = { positionDepth: 1, matrixDepth: 1, velocityDepth: 0, followDepth: 1, localMotion: false, shapeMotion: true, keepMatrix: false, keepOrigin: false }
const material = (mesh: number) => ({
  texture: 0,
  mesh,
  blend: 'add' as const,
  cull: 'none' as const,
  colorOp: 'modulate' as const,
  alphaOp: 'modulate' as const,
  d3d: { srcBlend: 5, dstBlend: 2, cull: 1, colorOp: 4, alphaOp: 4 },
})
function node(p: Partial<FxNode>): FxNode {
  return {
    name: 'n',
    parent: 0,
    frames: 20,
    life: 'extinct',
    emit: { start: 0, duration: 10, period: 1, limit: 10, rate: 1 },
    link: { ...LINK },
    render: 'none',
    view: 'none',
    material: null,
    commands: [],
    ...p,
  }
}

const synthetic: FxEffect = {
  format: FX_FORMAT,
  version: FX_VERSION,
  key: 'test/smoke.efp',
  fps: FX_FPS,
  scale: 1,
  textures: ['fx/tex/none.png'],
  meshes: ['fx/mesh/tri.glb'],
  nodes: [
    node({ parent: -1, emit: { start: 0, duration: 1, period: 1, limit: 1, rate: 1 }, frames: 40 }),
    node({
      render: 'plate',
      view: 'billboard',
      material: material(-1),
      commands: [
        { op: 'coneVel', basis: 'parent', min: 0.01, max: 0.02, angle: Math.PI, at: [0, 1, 1], flags: 2 },
        { op: 'shapeSpin', m: [0.99, 0.1, 0, -0.1, 0.99, 0, 0, 0, 1], at: [0, 1, 1], flags: 0 },
      ],
      scale: { at: [0, 1, 20], values: [3, 3, 1] },
      color: { at: [0, 1, 20], values: [1, 0.5, 0.25, 1] },
      uv: { at: [0, 1, 20], values: [0, 0, 0.5, 0.5] },
    }),
    node({ render: 'mesh', material: material(0), view: 'ybillboard' }),
    node({ render: 'pipe', material: material(-1), commands: [{ op: 'velocity', basis: 'world', v: [0, 0.05, 0], at: [0, 1, 1], flags: 0 }] }),
  ],
  duration: null,
  provenance: 'test',
  warnings: [],
}

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useRightHandedSystem = true
  new ArcRotateCamera('cam', 0.5, 1, 6, Vector3.Zero(), scene)
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
})

describe('FxInstance on NullEngine', () => {
  it('plays plates, meshes and pipes and writes finite geometry', () => {
    const lib = new FxLibrary(scene, '/out/')
    lib.addProgram(synthetic)
    lib.addMesh('fx/mesh/tri.glb', { positions: new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), uvs: new Float32Array(6), indices: new Uint32Array([0, 1, 2]) })
    const bone = new TransformNode('bone', scene)
    bone.position.set(0, 1.2, 0)
    const fx = new FxInstance(lib, synthetic, { pose: nodePose(bone) })
    for (let f = 0; f < 30; f++) {
      bone.position.x += 0.05
      fx.update(1 / 60)
      scene.render()
    }
    const s = fx.stats
    expect(s.batches).toBe(3)
    expect(s.elements).toBeGreaterThan(20)
    expect(s.drawn).toBeGreaterThan(10)
    const meshes = scene.meshes.filter(m => m.name.startsWith('fx:test/smoke.efp')) as Mesh[]
    expect(meshes).toHaveLength(3)
    for (const m of meshes) {
      const pos = m.getVerticesData(VertexBuffer.PositionKind)!
      expect(pos.length).toBeGreaterThan(0)
      expect([...pos].every(Number.isFinite)).toBe(true)
      expect(m.material?.alphaMode).toBe(1) // Constants.ALPHA_ADD
    }
    // Plates sit around the bone (which moved to x = 1.5).
    const plate = meshes.find(m => m.name.includes('#1'))!
    const p = plate.getVerticesData(VertexBuffer.PositionKind)!
    expect(Math.abs(p[1]! - 1.2)).toBeLessThan(0.5)
    fx.dispose()
    expect(scene.meshes.filter(m => m.name.startsWith('fx:test/smoke.efp'))).toHaveLength(0)
    lib.dispose()
  })

  const real = ['skill/china/cold_ganggi_keep_a.efp', 'skill/china/fire_ganggi_keep_a.efp', 'system/system_levelup.efp']
  it.skipIf(!existsSync(join(OUT, 'fx/efp/system/system_levelup.json')))('plays exported client effects end to end', async () => {
    const lib = new FxLibrary(scene, '/out/', async url => {
      const b = readFileSync(join(OUT, url.replace(/^\/out\//, '')))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    })
    for (const key of real) {
      const effect = await lib.load(key)
      const fx = new FxInstance(lib, effect, { position: [0, 0, 0] })
      let peak = 0
      for (let f = 0; f < 200 && !fx.finished; f++) {
        fx.update(1 / 30)
        scene.render()
        peak = Math.max(peak, fx.stats.drawn)
      }
      expect(peak, key).toBeGreaterThan(0)
      fx.dispose()
    }
    lib.dispose()
  })
})
