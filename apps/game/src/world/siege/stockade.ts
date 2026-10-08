/**
 * Siege of Jangan, layer 6 on the client (docs/SIEGE.md §8.5): the Garrison Stockade's look. Retail props from the world
 * export, placed at run time around the STOCKADE rectangle (nothing new is exported, the nav is untouched):
 *
 * - **the fence**: the Earth Ghost camp's stake fence (`w_earthgst_sfence`, ≈ 9 m a piece) along the four sides, with a
 *   3 m opening in the south side (the gate, toward the west camp);
 * - **the gate**: a cheval-de-frise (`w_cd_mc_bari`, the military camp's barricade) on each side of the opening;
 * - **inside**: a camp tent (`w_cd_mc_tent`) in the north-east corner, a table and a bench, and the rock pile of the
 *   chores (small field rocks, `w_cd_rock_s_0x`) in the north-west corner.
 *
 * The fence has no collision (the server clamps prisoners inside; visitors may walk up to it and in). Loaded when the
 * camera comes within 400 m; `dispose` frees everything.
 */
import { Quaternion, TransformNode, Vector3, type AbstractMesh, type AssetContainer, type Scene } from '@babylonjs/core'
import { WORLD_OBJECT_LAYER, loadGlb, type SidecarLite, type World } from '@sro/world-render'
import { STOCKADE } from '@sro/shared'

interface Prop {
  glb: string
  /** World x, z; yaw (rad, about +Y); scale. */
  x: number
  z: number
  yaw: number
  scale?: number
  /** Sink into the ground (m). */
  sink?: number
}

const FENCE = 'models/bldg/china/earthghost/w_earthgst_sfence.glb'
const FENCE_LEN = 8.6
const BARRICADE = 'models/bldg/china/dunhuang/milicamp/w_cd_mc_bari.glb'
const TENT = 'models/bldg/china/dunhuang/milicamp/w_cd_mc_tent.glb'
const TABLE = 'models/artifact/china/jangan/cj_table01.glb'
const BENCH = 'models/town/props/bench.glb'
/**
 * The field rocks and the scale that makes each a ≈ 1 m boulder (the retail 'small' rocks are 4-17 m across). Only
 * models the export places are served: w_cd_rock_s_03 stood only on the drowned Western China side (docs/COAST.md §4.1).
 */
const ROCKS: [string, number][] = [
  ['models/nature/china/dunhuang/rock/w_cd_rock_s_01.glb', 0.065],
  ['models/nature/china/dunhuang/rock/w_cd_rock_s_02.glb', 0.13],
]
/** Half the gate's opening (m). */
const GATE_HALF = 1.6

/** Fence pieces along a run from a to b (the piece's long axis is its local x). */
function run(ax: number, az: number, bx: number, bz: number): Prop[] {
  const len = Math.hypot(bx - ax, bz - az)
  const n = Math.max(1, Math.ceil(len / FENCE_LEN))
  const yaw = -Math.atan2(bz - az, bx - ax)
  const out: Prop[] = []
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n
    out.push({ glb: FENCE, x: ax + (bx - ax) * f, z: az + (bz - az) * f, yaw, scale: Math.min(1.05, len / n / FENCE_LEN + 0.04), sink: 0.15 })
  }
  return out
}

/** Every prop of the stockade (pure: tests read it). */
export function stockadeProps(): Prop[] {
  const { x0, x1, z0, z1, gate, pile } = STOCKADE
  const props: Prop[] = [
    // north, west, east sides; the south side in two runs either side of the gate
    ...run(x0, z0, x1, z0),
    ...run(x0, z0, x0, z1),
    ...run(x1, z0, x1, z1),
    ...run(x0, z1, gate.x - GATE_HALF, z1),
    ...run(gate.x + GATE_HALF, z1, x1, z1),
    // the gate's barricades, outside, along the fence
    { glb: BARRICADE, x: gate.x - GATE_HALF - 2.2, z: z1 + 1.6, yaw: Math.PI / 2, scale: 0.8 },
    { glb: BARRICADE, x: gate.x + GATE_HALF + 2.2, z: z1 + 1.6, yaw: Math.PI / 2, scale: 0.8 },
    // the guards' tent, a table and a bench
    { glb: TENT, x: x1 - 5, z: z0 + 6, yaw: Math.PI / 2, scale: 0.85 },
    { glb: TABLE, x: x1 - 6, z: z1 - 4.5, yaw: 0.3 },
    { glb: BENCH, x: x0 + 9, z: z1 - 3, yaw: 0 },
    { glb: BENCH, x: gate.x + 7, z: z0 + 2.5, yaw: Math.PI },
  ]
  // the rock pile of the chores
  const rocks: [number, number, number, number][] = [
    [0, 0, 0, 1.0],
    [1.6, 0.8, 1.2, 0.7],
    [-1.3, 1.1, 2.1, 0.75],
    [0.6, -1.5, 0.6, 0.6],
    [-1.0, -1.1, 2.9, 0.55],
    [2.2, -0.9, 1.7, 0.5],
  ]
  rocks.forEach(([dx, dz, yaw, s], i) => {
    const [glb, base] = ROCKS[i % ROCKS.length]!
    props.push({ glb, x: pile.x + dx, z: pile.z + dz, yaw, scale: s * base, sink: 0.05 })
  })
  return props
}

export class StockadeView {
  private readonly containers = new Map<string, { container: AssetContainer; converted: Awaited<ReturnType<World['materials']['convert']>> | null }>()
  private holder: TransformNode | null = null
  private disposed = false
  loaded = false

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
    private readonly ground: (x: number, z: number) => number,
  ) {}

  /** Loads the props' models and places them (a missing model is skipped). */
  async load(): Promise<void> {
    const props = stockadeProps()
    const holder = new TransformNode('siege:stockade', this.scene)
    this.holder = holder
    for (const glb of new Set(props.map((p) => p.glb))) {
      try {
        const container = await loadGlb(this.scene, this.world.assets, glb)
        if (this.disposed) {
          container.dispose()
          return
        }
        const sidecar = await this.world.assets.json<SidecarLite>(glb.replace(/\.glb$/, '.json')).catch(() => null)
        const converted = await this.world.materials.convert(container, sidecar, false, { model: glb, source: glb, kind: 'static' }).catch(() => null)
        this.containers.set(glb, { container, converted })
      } catch (err) {
        console.warn(`[stockade] ${glb} unavailable`, err)
      }
    }
    if (this.disposed) return
    props.forEach((p, i) => {
      const c = this.containers.get(p.glb)
      if (!c) return
      const node = new TransformNode(`stockade${i}`, this.scene)
      node.parent = holder
      const y = this.ground(p.x, p.z)
      node.position = new Vector3(p.x, (Number.isFinite(y) ? y : 0) - (p.sink ?? 0), p.z)
      node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), p.yaw)
      const s = p.scale ?? 1
      node.scaling = new Vector3(s, s, s)
      const entries = c.container.instantiateModelsToScene((n) => `${n}#stockade${i}`, false, { doNotInstantiate: true })
      for (const n of entries.rootNodes) n.parent = node
      for (const m of node.getChildMeshes(false) as AbstractMesh[]) {
        m.isPickable = false
        m.metadata = { sroWorld: 'object' }
        m.layerMask |= WORLD_OBJECT_LAYER
        m.receiveShadows = true
      }
    })
    this.loaded = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.holder?.dispose(false, false)
    this.holder = null
    for (const c of this.containers.values()) {
      if (c.converted) this.world.materials.release(c.converted)
      c.container.dispose()
    }
    this.containers.clear()
  }
}
