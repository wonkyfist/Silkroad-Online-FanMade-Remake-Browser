/**
 * A dragged tree looks like the tree players see (docs/TREES.md §W3.9, WF14; docs/WORLD_EDITOR.md §4.5, F7, D25;
 * docs/WAVE_PLAN8.md D16): while the editor holds a swapped tree (selected, dragged, or following the cursor to be
 * placed), its stand-in is T12-E's preview, the species' LOD0 as one overlay instance at the stand-in's matrix, and the
 * placement's merged copy is hidden at once (band 3). The objects view keeps its retail clone everywhere the swap does
 * not apply (Low, 'retail', a model without a species) and for every tree beyond the first (one preview instance).
 *
 * The objects view calls `attach(node, key, models)` where it would clone the models (true: skip the clone) and
 * `detach(node)` where it disposes that stand-in; its own S-OBJ re-batch has landed by then (it awaits the sync before
 * dropping a proxy), so the merged tree comes back the frame the preview goes. The preview follows the node's world
 * matrix on every frame the editor draws.
 */
import type { Observer, Scene, TransformNode } from '@babylonjs/core'
import type { WorldModel } from '../../../../../packages/convert/src/world/manifest.ts'
import { TreePreview, type TreePreviewHost } from '../../../../../packages/world-render/src/trees/editor.ts'
import { placementKey } from '../../../../../packages/world-render/src/trees/types.ts'

export class TreeLook {
  readonly preview: TreePreview
  private node: TransformNode | null = null
  private observer: Observer<Scene> | null = null

  constructor(private readonly scene: Scene, host: TreePreviewHost) {
    this.preview = new TreePreview(host)
  }

  /** The placement key of an export placement (its owner region and uid), as the trees part keys its slots. */
  static keyOf(p: { region: number; uid: number } | null | undefined): number | null {
    return p ? placementKey(p.region, p.uid) : null
  }

  /**
   * Takes a stand-in node for a swapped tree: true when the preview draws it (the caller skips its retail clone).
   * `models`: what the stand-in would clone (one swapped model; anything else stays retail).
   */
  attach(node: TransformNode, key: number | null, models: readonly WorldModel[]): boolean {
    if (models.length !== 1 || this.node) return false
    const carrier = models[0]!
    if (!this.preview.claims(carrier) || this.preview.busy) return false
    this.node = node
    // the preview starts on the next frame the editor draws: by then the caller has placed the stand-in (its matrix
    // is never the origin), and until then the merged tree simply stays where it is
    this.observer = this.scene.onBeforeRenderObservable.add(() => {
      if (this.preview.busy) return this.preview.update()
      if (this.node !== node) return
      if (!this.preview.begin(key, carrier, () => {
        if (node.isDisposed()) return null
        node.computeWorldMatrix(true)
        return node.getWorldMatrix().m
      })) this.detach(node)
    })
    return true
  }

  /** The stand-in goes (deselected, placed, cancelled): the preview ends, the merged tree is back. */
  detach(node: TransformNode): void {
    if (node !== this.node) return
    this.node = null
    if (this.observer) this.scene.onBeforeRenderObservable.remove(this.observer)
    this.observer = null
    this.preview.end()
  }

  /** True while `node` is drawn by the preview. */
  owns(node: TransformNode): boolean {
    return this.node === node
  }

  dispose(): void {
    if (this.node) this.detach(this.node)
    this.preview.dispose()
  }
}
