/**
 * The job system's world dressing on the client (docs/JOBS.md §5.1, §10; render side only, nothing new is exported and
 * the nav is untouched):
 *
 * - **Trade posts**: a market corner around each post's trader so the four posts out on the island read as trading
 *   places: the Jangan street stall behind the trader, a straw cart or a wagon beside him, baskets and stacks of goods
 *   crates (the retail goods bag, `drop_trade`) in front. Retail world props (the export places them elsewhere on the
 *   island), placed at run time relative to the trader's spot and facing; Jangan's Jodaesan stands in the town market
 *   already and gets nothing. Loaded per post when the player comes within LOAD_M.
 * - **Goods bags on the ground** (`bag` / `bagGone`, §6.3): a small stack of goods crates where each bag lies (one to
 *   three by its crates), so a robbed caravan's spill is seen, not only its prompt and minimap dot.
 *
 * No collision and not pickable (the trader stays clickable; a bag is picked through the prompt or the GM `bag`).
 */
import { Quaternion, TransformNode, Vector3, type AbstractMesh, type AssetContainer, type Scene } from '@babylonjs/core'
import { WORLD_OBJECT_LAYER, loadGlb, type SidecarLite, type World } from '@sro/world-render'
import type { TradeBag, TradePointId } from '@sro/shared'

/** A prop in the post's frame: `f` metres along the trader's facing (toward his customers), `r` to his right. */
export interface PostProp {
  /** A world model (the export's path), or 'crate' for the goods bag. */
  glb: string | 'crate'
  f: number
  r: number
  /** Yaw relative to the trader's facing (rad); scale; height above the ground (stacked crates). */
  yaw: number
  scale?: number
  up?: number
  /** Its footprint's radius (m): it stands on the lowest ground under it (a slope never leaves it floating). */
  foot?: number
}

const STALL = 'models/bldg/china/jangan01/cj_streetstall.glb'
const CART = 'models/artifact/china/greenfield/cj_strawcart.glb'
const WAGON = 'models/artifact/oasis/tarim/oas_tarim_wagone.glb'
const BASKET = 'models/artifact/china/greenfield/cj_potato_basket.glb'

/** The goods crate's scale on the ground (the retail bag is a 0.18 m drop at scale 1: ≈ 0.55 m crates). */
export const CRATE_SCALE = 3.2
const CRATE_H = 0.072 * CRATE_SCALE

/** A stack of goods crates at (f, r): `n` of them, two on the ground, then one on top. */
function crates(f: number, r: number, n: number, yaw = 0): PostProp[] {
  const spots: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [0.05, 0.62, 0, 0.25],
    [0.02, 0.3, CRATE_H, -0.35],
    [0.6, 0.15, 0, 0.6],
  ]
  return spots.slice(0, n).map(([df, dr, up, y]) => ({ glb: 'crate' as const, f: f + df, r: r + dr, yaw: yaw + y, scale: CRATE_SCALE, up }))
}

/**
 * Each post's corner [decision]: a stall behind the trader; a straw cart (the two western landings the oasis wagon);
 * crates and a basket in front. Measured on the props' glbs: the stall ≈ 4 m wide,
 * the cart ≈ 3 m long, the wagon ≈ 5 m.
 */
export const POST_PROPS: Readonly<Partial<Record<TradePointId, readonly PostProp[]>>> = {
  'south-beach': [
    { glb: STALL, f: -3.6, r: 0, yaw: 0, foot: 2 },
    { glb: CART, f: 0.2, r: 4.2, yaw: Math.PI / 2, foot: 1.4 },
    { glb: BASKET, f: 1.2, r: 1.9, yaw: 0.4 },
    ...crates(1.0, -2.6, 3, 0.2),
    ...crates(-0.6, -3.6, 2, -0.3),
  ],
  'tomb-camp': [
    { glb: STALL, f: -3.6, r: 0, yaw: 0, foot: 2 },
    { glb: CART, f: 0, r: -4.4, yaw: -Math.PI / 2, foot: 1.4 },
    ...crates(1.1, 2.4, 4, -0.2),
    { glb: BASKET, f: 1.4, r: -1.8, yaw: 1.2 },
  ],
  'ferry-landing': [
    { glb: STALL, f: -3.6, r: 0, yaw: 0, foot: 2 },
    { glb: WAGON, f: 0, r: 5.2, yaw: Math.PI / 2, scale: 0.85, foot: 2 },
    ...crates(1.0, -2.6, 4, 0.3),
    { glb: BASKET, f: 1.3, r: 1.9, yaw: 0.2 },
  ],
  'sea-cliffs': [
    { glb: STALL, f: -3.6, r: 0, yaw: 0, foot: 2 },
    { glb: WAGON, f: 0, r: -5.2, yaw: -Math.PI / 2, scale: 0.85, foot: 2 },
    ...crates(1.0, 2.4, 3, -0.2),
    ...crates(-0.5, 3.4, 2, 0.4),
    { glb: BASKET, f: 1.3, r: -1.9, yaw: 0.8 },
  ],
}

/** World x, z and yaw of a post prop (the trader at (x, z) facing protocol yaw `yaw` = atan2(dx, dz)). */
export function postPropAt(post: { x: number; z: number; yaw: number }, p: Pick<PostProp, 'f' | 'r' | 'yaw'>): { x: number; z: number; yaw: number } {
  const fx = Math.sin(post.yaw)
  const fz = Math.cos(post.yaw)
  // his right hand: the facing turned a quarter clockwise seen from above (+x east, +z south on the map)
  const rx = -fz
  const rz = fx
  return { x: post.x + fx * p.f + rx * p.r, z: post.z + fz * p.f + rz * p.r, yaw: post.yaw + p.yaw }
}

/** The crates a bag on the ground shows (1-3 by its crates). */
export function bagCrates(crates: number): number {
  return crates >= 12 ? 3 : crates >= 4 ? 2 : 1
}

type CrateSource = () => Promise<TransformNode | null>

/** Loads world props once each, places instances; shared by the posts. */
class PropLoader {
  private readonly cache = new Map<string, Promise<{ container: AssetContainer; converted: Awaited<ReturnType<World['materials']['convert']>> | null } | null>>()
  disposed = false

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
  ) {}

  load(glb: string) {
    let p = this.cache.get(glb)
    if (!p) {
      p = (async () => {
        try {
          const container = await loadGlb(this.scene, this.world.assets, glb)
          const sidecar = await this.world.assets.json<SidecarLite>(glb.replace(/\.glb$/, '.json')).catch(() => null)
          const converted = await this.world.materials.convert(container, sidecar, false, { model: glb, source: glb, kind: 'static' }).catch(() => null)
          return { container, converted }
        } catch (err) {
          console.warn(`[trade-posts] ${glb} unavailable`, err)
          return null
        }
      })()
      this.cache.set(glb, p)
    }
    return p
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.cache.values()) {
      void p.then((c) => {
        if (!c) return
        if (c.converted) this.world.materials.release(c.converted)
        c.container.dispose()
      })
    }
    this.cache.clear()
  }
}

function finish(node: TransformNode): void {
  for (const m of node.getChildMeshes(false) as AbstractMesh[]) {
    m.isPickable = false
    m.metadata = { sroWorld: 'object' }
    m.layerMask |= WORLD_OBJECT_LAYER
    m.receiveShadows = true
  }
}

/** The posts' dressing and the bags on the ground. */
export class TradeWorldView {
  private readonly props: PropLoader
  private readonly posts = new Map<TradePointId, TransformNode>()
  private readonly bags = new Map<number, TransformNode>()
  /** Every placed node with its spot: snapped to the ground again on each sync (the terrain streams in after a warp). */
  private readonly grounded: { node: TransformNode; x: number; z: number; up: number; foot: number }[] = []
  private disposed = false

  constructor(
    private readonly scene: Scene,
    world: World,
    private readonly ground: (x: number, z: number) => number,
    private readonly crate: CrateSource,
  ) {
    this.props = new PropLoader(scene, world)
  }

  get postsShown(): TradePointId[] {
    return [...this.posts.keys()]
  }

  get bagsShown(): number {
    return this.bags.size
  }

  private y(x: number, z: number): number {
    const y = this.ground(x, z)
    return Number.isFinite(y) ? y : 0
  }

  /** The lowest ground under a footprint of radius `foot` around (x, z) (its centre alone at 0). */
  private low(x: number, z: number, foot: number): number {
    let y = this.ground(x, z)
    if (foot > 0) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const h = this.ground(x + dx * foot, z + dz * foot)
        if (Number.isFinite(h) && (!Number.isFinite(y) || h < y)) y = h
      }
    }
    return y
  }

  private ground_(node: TransformNode, x: number, z: number, up: number, foot = 0): void {
    const y = this.low(x, z, foot)
    node.position = new Vector3(x, (Number.isFinite(y) ? y : 0) + up, z)
    this.grounded.push({ node, x, z, up, foot })
  }

  /** Snaps every placed post prop and bag to the ground again (cheap: a few dozen nodes). */
  resnap(): void {
    for (let i = this.grounded.length - 1; i >= 0; i--) {
      const g = this.grounded[i]!
      if (g.node.isDisposed()) {
        this.grounded.splice(i, 1)
        continue
      }
      const y = this.low(g.x, g.z, g.foot)
      if (Number.isFinite(y) && Math.abs(g.node.position.y - (y + g.up)) > 0.01) g.node.position.y = y + g.up
    }
  }

  /** Places post `id`'s corner (once). */
  async showPost(id: TradePointId, post: { x: number; z: number; yaw: number }): Promise<void> {
    const list = POST_PROPS[id]
    if (!list || this.posts.has(id) || this.disposed) return
    const holder = new TransformNode(`tradePost:${id}`, this.scene)
    this.posts.set(id, holder)
    await Promise.all(
      list.map(async (p, i) => {
        const at = postPropAt(post, p)
        const node = new TransformNode(`tradePost:${id}:${i}`, this.scene)
        node.parent = holder
        this.ground_(node, at.x, at.z, p.up ?? 0, p.foot ?? 0)
        node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), at.yaw)
        const s = p.scale ?? 1
        node.scaling = new Vector3(s, s, s)
        if (p.glb === 'crate') {
          const src = await this.crate()
          if (!src || this.disposed || holder.isDisposed()) return
          const c = src.clone(`tradePostCrate:${id}:${i}`, node, false)
          c?.setEnabled(true)
        } else {
          const c = await this.props.load(p.glb)
          if (!c || this.disposed || holder.isDisposed()) return
          const entries = c.container.instantiateModelsToScene((n) => `${n}#tradePost:${id}:${i}`, false, { doNotInstantiate: true })
          for (const n of entries.rootNodes) n.parent = node
        }
        finish(node)
      }),
    )
  }

  /** A bag on the ground (again: moved / re-stacked). */
  async showBag(b: Pick<TradeBag, 'id' | 'x' | 'z' | 'crates'>): Promise<void> {
    if (this.disposed) return
    this.hideBag(b.id)
    const holder = new TransformNode(`tradeBag:${b.id}`, this.scene)
    this.bags.set(b.id, holder)
    this.ground_(holder, b.x, b.z, 0)
    holder.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), (b.id * 2.399) % (Math.PI * 2))
    const src = await this.crate()
    if (!src || this.disposed || holder.isDisposed()) return
    crates(0, 0, bagCrates(b.crates)).forEach((p, i) => {
      const node = new TransformNode(`tradeBag:${b.id}:${i}`, this.scene)
      node.parent = holder
      node.position = new Vector3(p.r - 0.3, p.up ?? 0, p.f)
      node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), p.yaw)
      node.scaling = new Vector3(CRATE_SCALE * 0.85, CRATE_SCALE * 0.85, CRATE_SCALE * 0.85)
      const c = src.clone(`tradeBagCrate:${b.id}:${i}`, node, false)
      c?.setEnabled(true)
    })
    finish(holder)
  }

  hideBag(id: number): void {
    this.bags.get(id)?.dispose(false, false)
    this.bags.delete(id)
  }

  clearBags(): void {
    for (const id of [...this.bags.keys()]) this.hideBag(id)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const h of this.posts.values()) h.dispose(false, false)
    this.posts.clear()
    this.clearBags()
    this.props.dispose()
  }
}
