/**
 * The library's thumbnails (docs/WORLD_EDITOR.md §4.5, D26; docs/WAVE_PLAN8.md §6.2 WE-L): rendered by the editor
 * itself with the game's materials (the converted model from the stream's model cache, lit by the editor's scene), a
 * 128² picture per model, cached in the browser (IndexedDB), outside git. The new species bring their own (the tree
 * tool's LOD0 thumbnail under work/out/trees/), so only converted retail models are rendered here.
 *
 * One bake at a time, only for rows the list shows (an IntersectionObserver), and never while another owner holds the
 * GPU lock (the editor's banner) or the tab is hidden: the editor neither skews a bench nor renders in the background.
 * A bake adds one small render target to the next frame the editor draws (scene.customRenderTargets), draws only the
 * model's copy on a layer the editor's camera never sees, reads it back and drops it.
 */
import {
  Color4, RenderTargetTexture, TargetCamera, TransformNode, Vector3,
  type AbstractMesh, type AssetContainer, type Scene,
} from '@babylonjs/core'
import type { WorldManifest } from '../../../../../packages/convert/src/world/manifest.ts'
import type { EditorLibraryItem } from './library.ts'

/** The thumbnail size (px). */
export const THUMB_SIZE = 128
/** The layer only the thumbnail camera sees (the editor's camera keeps Babylon's default 0x0fffffff). */
export const THUMB_LAYER = 0x10000000
/** The model cache owner of the thumbnail copies (WE-U's proxies use 900_000_001). */
export const THUMB_OWNER = 900_000_002
/** Bump to re-render every cached thumbnail (a lighting or framing change). */
export const THUMB_VERSION = 2
/** Frames a copy may wait for its materials to compile before it is drawn anyway. */
const READY_FRAMES = 90

const DB_NAME = 'sro-editor-thumbs'
const STORE = 'thumbs'

/** The cache key of a model set: the world, the glbs and their sizes (a re-convert that changes a model re-renders). */
export function thumbKey(world: string, manifest: Pick<WorldManifest, 'models'>, models: readonly number[]): string {
  const parts = models.map(mi => {
    const m = manifest.models[mi]
    return m ? `${m.glb ?? ''}:${m.bytes ?? 0}` : `?${mi}`
  })
  return `v${THUMB_VERSION}|${world}|${parts.join('+')}`
}

/**
 * A camera framing a bounding box from the front-left and a little above (the census sheets' three-quarter view):
 * returns the eye and the target for a vertical field of view `fov`.
 */
export function frameBox(min: ArrayLike<number>, max: ArrayLike<number>, fov: number): { eye: [number, number, number]; target: [number, number, number] } {
  const c: [number, number, number] = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2]
  const r = Math.max(0.25, Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2)
  const d = (r / Math.sin(fov / 2)) * 1.02
  const yaw = Math.PI * 0.25, pitch = 0.42
  const eye: [number, number, number] = [c[0] + d * Math.cos(pitch) * Math.sin(yaw), c[1] + d * Math.sin(pitch), c[2] + d * Math.cos(pitch) * Math.cos(yaw)]
  return { eye, target: c }
}

/**
 * RGBA8 pixels to a PNG blob through a 2D canvas (no second engine). `flipY`: the render target's rows come bottom-up
 * (Babylon's own screenshot path inverts them on both engines). `srgb`: the target holds linear colour (the scene's
 * tone mapping and gamma are a post-process of the editor's camera), so the picture gets the sRGB curve.
 */
export async function encodePng(px: Uint8Array, w: number, h: number, flipY: boolean, srgb = false): Promise<Blob | null> {
  const rows = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = (flipY ? h - 1 - y : y) * w * 4
    rows.set(px.subarray(from, from + w * 4), y * w * 4)
  }
  if (srgb) {
    const lut = new Uint8ClampedArray(256)
    for (let i = 0; i < 256; i++) {
      const c = i / 255
      lut[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))
    }
    for (let i = 0; i < rows.length; i += 4) {
      rows[i] = lut[rows[i]!]!
      rows[i + 1] = lut[rows[i + 1]!]!
      rows[i + 2] = lut[rows[i + 2]!]!
    }
  }
  const image = new ImageData(rows, w, h)
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h)
    const g = c.getContext('2d')
    if (!g) return null
    g.putImageData(image, 0, 0)
    return c.convertToBlob({ type: 'image/png' })
  }
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) return null
  g.putImageData(image, 0, 0)
  return new Promise(resolve => c.toBlob(b => resolve(b), 'image/png'))
}

/** The IndexedDB cache (every call answers null / no-op when storage is unavailable: a private window, a test). */
class ThumbStore {
  private db: Promise<IDBDatabase | null> | null = null

  private open(): Promise<IDBDatabase | null> {
    if (this.db) return this.db
    this.db = new Promise(resolve => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null)
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    return this.db
  }

  async get(key: string): Promise<Blob | null> {
    const db = await this.open()
    if (!db) return null
    return new Promise(resolve => {
      try {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
        req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null)
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }

  async put(key: string, blob: Blob): Promise<void> {
    const db = await this.open()
    if (!db) return
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(blob, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  }
}

/** What the thumbnails need of the editor. */
export interface ThumbHost {
  readonly scene: Scene
  readonly world: string
  readonly manifest: Pick<WorldManifest, 'models'>
  /** The stream's model cache (World.stream.models), or null (nothing to render with). */
  models(): { acquire(index: number, owner: number): Promise<{ container: AssetContainer }>; release(index: number, owner: number): void } | null
  /** Where the copy stands while it is drawn (above the camera's ground point: lit, out of every shadow). */
  spot(): Vector3
  /** Ask the editor for a frame. */
  invalidate(): void
  /** True while bakes must wait (another owner holds the GPU lock). */
  paused(): boolean
}

interface Want {
  item: EditorLibraryItem
  key: string
  done: Array<(url: string | null) => void>
}

/** The thumbnail baker and cache (see the file comment). */
export class LibraryThumbs {
  private readonly store = new ThumbStore()
  private readonly urls = new Map<string, string | null>()
  private readonly queue: Want[] = []
  private readonly byKey = new Map<string, Want>()
  private running = false
  private disposed = false
  /** Counters for the status line and the tests. */
  readonly stats = { baked: 0, cached: 0, failed: 0 }

  constructor(readonly host: ThumbHost) {}

  /** The thumbnail URL of an item if it is known now (a species' file, or a cached render), else undefined. */
  known(item: EditorLibraryItem): string | null | undefined {
    if (item.thumb) return item.thumb
    if (!item.models.length) return null
    return this.urls.get(thumbKey(this.host.world, this.host.manifest, item.models))
  }

  /** Asks for an item's thumbnail; `done` gets its URL (null: none could be made). */
  request(item: EditorLibraryItem, done: (url: string | null) => void): void {
    const k = this.known(item)
    if (k !== undefined) return done(k)
    const key = thumbKey(this.host.world, this.host.manifest, item.models)
    const w = this.byKey.get(key)
    if (w) {
      w.done.push(done)
      return
    }
    const want: Want = { item, key, done: [done] }
    this.byKey.set(key, want)
    this.queue.push(want)
    void this.pump()
  }

  /** Drops the wishes of rows no longer shown (a new search, a tab change). */
  cancelAll(): void {
    for (const w of this.queue.splice(0)) this.byKey.delete(w.key)
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.disposed && this.queue.length) {
        if (this.host.paused() || (typeof document !== 'undefined' && document.hidden)) {
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        const w = this.queue.shift()!
        let url: string | null = null
        try {
          const cached = await this.store.get(w.key)
          if (cached) {
            url = URL.createObjectURL(cached)
            this.stats.cached++
          } else {
            const blob = await this.bake(w.item.models)
            if (blob) {
              url = URL.createObjectURL(blob)
              this.stats.baked++
              void this.store.put(w.key, blob)
            } else this.stats.failed++
          }
        } catch (err) {
          console.warn('[editor] thumbnail failed', w.item.source, err)
          this.stats.failed++
        }
        this.urls.set(w.key, url)
        this.byKey.delete(w.key)
        for (const d of w.done) d(url)
      }
    } finally {
      this.running = false
    }
  }

  /** Renders one model set to a PNG (null: nothing drawable). */
  private async bake(models: readonly number[]): Promise<Blob | null> {
    const cache = this.host.models()
    if (!cache) return null
    const scene = this.host.scene
    const root = new TransformNode('editorThumb', scene)
    const held: number[] = []
    const meshes: AbstractMesh[] = []
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
    let rtt: RenderTargetTexture | null = null
    let cam: TargetCamera | null = null
    try {
      for (const mi of models) {
        const m = this.host.manifest.models[mi]
        if (!m) continue
        const c = await cache.acquire(mi, THUMB_OWNER)
        held.push(mi)
        const inst = c.container.instantiateModelsToScene(n => `${n}#thumb`, false, { doNotInstantiate: true })
        for (const r of inst.rootNodes) r.parent = root
        min.minimizeInPlaceFromFloats(m.boundsMin[0], m.boundsMin[1], m.boundsMin[2])
        max.maximizeInPlaceFromFloats(m.boundsMax[0], m.boundsMax[1], m.boundsMax[2])
      }
      if (this.disposed) return null
      for (const mesh of root.getChildMeshes(false)) {
        mesh.setEnabled(true)
        mesh.isPickable = false
        mesh.layerMask = THUMB_LAYER
        mesh.alwaysSelectAsActiveMesh = true
        if (mesh.getTotalVertices() > 0) meshes.push(mesh)
      }
      if (!meshes.length || !Number.isFinite(min.x)) return null
      const spot = this.host.spot()
      root.position.copyFrom(spot)
      root.computeWorldMatrix(true)
      for (const mesh of meshes) mesh.computeWorldMatrix(true)
      const fov = 0.55
      const f = frameBox([min.x, min.y, min.z], [max.x, max.y, max.z], fov)
      cam = new TargetCamera('editorThumbCam', new Vector3(f.eye[0] + spot.x, f.eye[1] + spot.y, f.eye[2] + spot.z), scene, false)
      cam.setTarget(new Vector3(f.target[0] + spot.x, f.target[1] + spot.y, f.target[2] + spot.z))
      cam.fov = fov
      cam.minZ = 0.05
      cam.maxZ = 4000
      cam.layerMask = THUMB_LAYER
      // the editor's camera stays the scene's active camera (a new camera never takes over)
      rtt = new RenderTargetTexture('editorThumbRT', THUMB_SIZE, scene, false, true)
      rtt.activeCamera = cam
      rtt.renderList = meshes
      rtt.clearColor = new Color4(0, 0, 0, 0)
      rtt.renderParticles = false
      rtt.renderSprites = false
      // wait (a few frames) for the copy's materials; then one frame draws it
      for (let i = 0; i < READY_FRAMES && !meshes.every(m => m.isReady(true)); i++) await this.frame()
      if (this.disposed) return null
      scene.customRenderTargets.push(rtt)
      await this.frame()
      const k = scene.customRenderTargets.indexOf(rtt)
      if (k >= 0) scene.customRenderTargets.splice(k, 1)
      const px = await rtt.readPixels(0, 0, null, true, false)
      if (!px) return null
      const data = px instanceof Uint8Array ? px : new Uint8Array(px.buffer, px.byteOffset, px.byteLength)
      let opaque = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 8) opaque++
      if (!opaque) return null
      return await encodePng(data, THUMB_SIZE, THUMB_SIZE, true, true)
    } finally {
      if (rtt) {
        const k = scene.customRenderTargets.indexOf(rtt)
        if (k >= 0) scene.customRenderTargets.splice(k, 1)
        rtt.dispose()
      }
      cam?.dispose()
      root.dispose(false, false)
      for (const mi of held) cache.release(mi, THUMB_OWNER)
      this.host.invalidate()
    }
  }

  /** Resolves after the editor drew one more frame. */
  private frame(): Promise<void> {
    return new Promise(resolve => {
      const engine = this.host.scene.getEngine()
      let done = false
      const ob = engine.onEndFrameObservable.addOnce(() => {
        done = true
        resolve()
      })
      this.host.invalidate()
      // a frame that never comes (the editor paused, the tab hidden): give up after a second
      setTimeout(() => {
        if (done) return
        engine.onEndFrameObservable.remove(ob)
        resolve()
      }, 1000)
    })
  }

  dispose(): void {
    this.disposed = true
    this.cancelAll()
    for (const u of this.urls.values()) if (u && u.startsWith('blob:')) URL.revokeObjectURL(u)
    this.urls.clear()
  }
}
