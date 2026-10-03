/**
 * W9A perf pass: the enabled-only active-mesh candidates (render/active-meshes.ts). The list holds exactly the enabled
 * meshes in scene order after every kind of change (a mesh's own switch, an ancestor's, a re-parent, a mesh added or
 * disposed), the frame's active meshes are the same as with Babylon's own provider, and dispose hands the scene its
 * provider back. World installs it by default and switches it at run time.
 */
import { ArcRotateCamera, MeshBuilder, NullEngine, Scene, TransformNode, Vector3, type AbstractMesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { EnabledMeshCandidates } from '../src/render/active-meshes.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function scene(): Scene {
  const engine = new NullEngine()
  const s = new Scene(engine)
  new ArcRotateCamera('cam', 0, 1, 20, Vector3.Zero(), s)
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

const names = (c: EnabledMeshCandidates) => {
  const l = c.candidates()
  return Array.from({ length: l.length }, (_, i) => (l.data[i] as AbstractMesh).name)
}
const expected = (s: Scene) => s.meshes.filter(m => m.isEnabled()).map(m => m.name)

describe('EnabledMeshCandidates', () => {
  it('keeps exactly the enabled meshes, in scene order, through every kind of change', () => {
    const s = scene()
    const a = MeshBuilder.CreateBox('a', {}, s)
    const root = new TransformNode('template', s)
    const b = MeshBuilder.CreateBox('b', {}, s)
    b.parent = root
    const c = MeshBuilder.CreateBox('c', {}, s)
    c.setEnabled(false)
    const cands = new EnabledMeshCandidates(s)
    cleanups.unshift(() => cands.dispose())
    expect(s.getActiveMeshCandidates()).toBe(cands.candidates())
    expect(names(cands)).toEqual(['a', 'b'])
    // An ancestor switched off and on.
    root.setEnabled(false)
    expect(names(cands)).toEqual(['a'])
    root.setEnabled(true)
    expect(names(cands)).toEqual(['a', 'b'])
    // A mesh's own switch.
    c.setEnabled(true)
    a.setEnabled(false)
    expect(names(cands)).toEqual(['b', 'c'])
    // Re-parented under a disabled node, and back out.
    const hidden = new TransformNode('pool', s)
    hidden.setEnabled(false)
    c.parent = hidden
    expect(names(cands)).toEqual(['b'])
    c.parent = null
    expect(names(cands)).toEqual(['b', 'c'])
    // A mesh added (also one made under a disabled parent), one disposed.
    const d = MeshBuilder.CreateBox('d', {}, s)
    const e = MeshBuilder.CreateBox('e', {}, s)
    e.parent = hidden
    expect(names(cands)).toEqual(['b', 'c', 'd'])
    hidden.setEnabled(true)
    expect(names(cands)).toEqual(['b', 'c', 'd', 'e'])
    b.dispose()
    expect(names(cands)).toEqual(expected(s))
    expect(names(cands)).toEqual(['c', 'd', 'e'])
    // A clone of a disabled template stays out until it is shown.
    root.setEnabled(false)
    const f = d.clone('f', root)!
    expect(names(cands)).toEqual(['c', 'd', 'e'])
    f.parent = null
    expect(names(cands)).toEqual(['c', 'd', 'e', 'f'])
    // No change: no rebuild.
    const n = cands.rebuilds
    cands.candidates()
    cands.candidates()
    expect(cands.rebuilds).toBe(n)
  })

  it('a frame activates the same meshes as Babylon\'s own provider; dispose gives the provider back', () => {
    const s = scene()
    const meshes: AbstractMesh[] = []
    for (let i = 0; i < 40; i++) {
      const m = MeshBuilder.CreateBox(`m${i}`, {}, s)
      m.position.set((i % 8) * 3 - 12, 0, Math.floor(i / 8) * 3 - 6)
      if (i % 3 === 0) m.setEnabled(false)
      meshes.push(m)
    }
    const active = () => {
      s.render()
      const l = s.getActiveMeshes()
      return Array.from({ length: l.length }, (_, i) => l.data[i]!.name)
    }
    const before = active()
    const original = s.getActiveMeshCandidates
    const cands = new EnabledMeshCandidates(s)
    expect(active()).toEqual(before)
    meshes[0]!.setEnabled(true)
    meshes[1]!.setEnabled(false)
    const withList = active()
    cands.dispose()
    expect(s.getActiveMeshCandidates).toBe(original)
    expect(active()).toEqual(withList)
    expect(withList).toContain('m0')
    expect(withList).not.toContain('m1')
  })

  it('G1 rescue: a pick-only mesh (an invisible entity pick proxy, never drawn) is no candidate', () => {
    const s = scene()
    MeshBuilder.CreateBox('body', {}, s)
    const pick = MeshBuilder.CreateCylinder('pick1', {}, s)
    pick.isVisible = false
    pick.metadata = { entityId: 7, sroPickOnly: true }
    const plain = MeshBuilder.CreateCylinder('pick2', {}, s)
    plain.isVisible = false
    plain.metadata = { entityId: 8 }
    const cands = new EnabledMeshCandidates(s)
    const c = cands.candidates()
    expect(Array.from({ length: c.length }, (_, i) => c.data[i]!.name)).toEqual(['body', 'pick2'])
    cands.dispose()
  })
})
