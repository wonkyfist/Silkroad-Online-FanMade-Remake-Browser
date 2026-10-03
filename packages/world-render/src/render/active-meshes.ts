/**
 * Active-mesh candidates without the disabled meshes (W9A perf pass). Babylon walks every mesh of the scene twice a
 * frame, once in scene.render's world-matrix pass and once in _evaluateActiveMeshes, and a disabled mesh still costs
 * its LOD bookkeeping, vertex count and isReady() before the isEnabled() test skips it. The game scene holds about
 * 3,700 meshes of which only about 1,800 are enabled (hidden equipment and body parts, pooled and template meshes
 * under glTF `__root__` nodes); the profile measured -1.2 ms of CPU per frame at High for handing Babylon only the
 * enabled ones.
 *
 * The list is kept, not filtered per frame: it is rebuilt (in scene order, so the draw order is unchanged) only after a
 * mesh was added or removed or a mesh's effective enabled state changed. Babylon 9 reports the latter through
 * `onEffectiveEnabledStateChangedObservable`, which also fires when an ancestor is switched or a node is re-parented.
 * A disabled mesh is skipped by Babylon anyway, so leaving it out changes nothing on screen: the Classic path draws the
 * same image (the Low guard).
 *
 * G1 rescue: a mesh tagged `metadata.sroPickOnly` (the game's invisible entity pick proxies, one or two per character)
 * is left out too: it is never drawn, and scene.pick computes the world matrix of every mesh it tests itself, so its
 * per-frame world-matrix pass was only cost (80 proxies at a 20-player boss fight). The tag is read at each rebuild.
 */
import type { AbstractMesh, Observer, Scene } from '@babylonjs/core'

type CandidateList = ReturnType<Scene['getActiveMeshCandidates']>

export class EnabledMeshCandidates {
  /** Rebuilds so far (tests, the perf probe). */
  rebuilds = 0
  private readonly list: AbstractMesh[] = []
  private readonly out: { data: AbstractMesh[]; length: number } = { data: this.list, length: 0 }
  private dirty = true
  /** scene.meshes' length and last mesh at the last rebuild (a new mesh is always pushed to the end). */
  private seenLength = -1
  private seenLast: AbstractMesh | null = null
  private readonly watched = new Map<AbstractMesh, Observer<boolean>>()
  private readonly original: Scene['getActiveMeshCandidates']
  private readonly provider: Scene['getActiveMeshCandidates']
  private readonly offs: Array<() => void> = []
  private readonly mark = () => {
    this.dirty = true
  }
  private disposed = false

  constructor(readonly scene: Scene) {
    this.original = scene.getActiveMeshCandidates
    for (const m of scene.meshes) this.watch(m)
    const added = scene.onNewMeshAddedObservable.add(m => {
      this.watch(m)
      this.dirty = true
    })
    const removed = scene.onMeshRemovedObservable.add(m => {
      this.unwatch(m)
      this.dirty = true
    })
    this.offs.push(() => scene.onNewMeshAddedObservable.remove(added), () => scene.onMeshRemovedObservable.remove(removed))
    this.provider = () => this.candidates()
    scene.getActiveMeshCandidates = this.provider
  }

  /** The enabled meshes of the scene, in scene order (rebuilt when something changed). */
  candidates(): CandidateList {
    // Babylon tells about a new mesh only on the next tick (Scene.addMesh defers onNewMeshAddedObservable), so new
    // meshes are found here: addMesh pushes to the end, a removal is reported at once.
    const ms = this.scene.meshes
    if (ms.length !== this.seenLength || ms[ms.length - 1] !== this.seenLast) {
      for (let i = ms.length - 1; i >= 0 && !this.watched.has(ms[i]!); i--) this.watch(ms[i]!)
      this.dirty = true
    }
    if (this.dirty) this.rebuild()
    return this.out as unknown as CandidateList
  }

  /** How many meshes the last rebuild kept. */
  get length(): number {
    return this.out.length
  }

  private rebuild(): void {
    this.dirty = false
    this.rebuilds++
    const src = this.scene.meshes
    let n = 0
    for (let i = 0; i < src.length; i++) {
      const m = src[i]!
      if (m.isEnabled() && !(m.metadata as { sroPickOnly?: boolean } | null)?.sroPickOnly) this.list[n++] = m
    }
    this.list.length = n
    this.out.length = n
    this.seenLength = src.length
    this.seenLast = src[src.length - 1] ?? null
  }

  private watch(m: AbstractMesh): void {
    if (this.watched.has(m)) return
    this.watched.set(m, m.onEffectiveEnabledStateChangedObservable.add(this.mark))
  }

  private unwatch(m: AbstractMesh): void {
    const o = this.watched.get(m)
    if (!o) return
    this.watched.delete(m)
    m.onEffectiveEnabledStateChangedObservable.remove(o)
  }

  /** Hands the scene its own candidate provider back (only if nobody replaced this one since). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.offs.splice(0)) off()
    for (const [m, o] of this.watched) m.onEffectiveEnabledStateChangedObservable.remove(o)
    this.watched.clear()
    if (this.scene.getActiveMeshCandidates === this.provider) this.scene.getActiveMeshCandidates = this.original
    this.list.length = 0
    this.out.length = 0
  }
}
