/**
 * The job system's looks on the client (docs/JOBS.md §3.3, §10; layer 6), render side only:
 *
 * - **Suits**: `EntityState.job` / `entityUpdate.job` ({job, level} in job mode, null off) re-dresses the view
 *   (EntityView.setJob → ModelLibrary.dress): a licensed Waterbender body keeps its outfit in the job's colours with the
 *   emblem and the level's pips (three/job-look.ts, licensed-cloth.ts); a retail body wears the retail suit.
 * - **Name plates**: one job line under the name for everyone to see, in the job's colour with its badge ("TRADER ·
 *   Peddler", gold; "BOUNTY HUNTER · Tracker", blue; "THIEF · Pickpocket", red). It replaces the siege's Bounty
 *   Hunter badge while the job is shown (law.ts draws that one only without a job line: no double tag).
 * - **Transports** (cos `COS_T_*`): the load's crates (the retail goods bag) on the pack saddle, more and bigger with
 *   more stars (one small bundle at 1 star, ten piled high at 5; `EntityState.stars` / `entityUpdate.stars`), and the
 *   stars over it.
 * - **The world** (world/jobs/trade-world.ts): the trade posts' market corners (stall, cart or wagon, crates, baskets)
 *   within POST_LOAD_M, and a stack of goods crates where each goods bag lies (`bag` / `bagGone`).
 * - Debug: `window.__sroJobs` — `preview({ job: 'trader', level: 7 })` dresses the own character (or `id`) as if in
 *   job mode, `preview({ id, stars: 3 })` loads a transport's look, `preview(null)` back to the server's state;
 *   `state()` lists the job members and transports in view. Client side only: the server's next update wins.
 */
import { Matrix, Quaternion, TransformNode, Vector3, type Camera, type Node, type Observer } from '@babylonjs/core'
import { JOB_CODES, JOBS_CONTENT, isTransportCos, type JobBadge, type TradeBag } from '@sro/shared'
import { TradeWorldView } from '../jobs/trade-world.ts'
import { t } from '../../i18n/index.ts'
import { JOB_PLATE_COLOURS, JOB_PLATE_KEYS, TRANSPORT_LOAD, bundleCount, bundleScale, jobPlate } from '../../three/job-look.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

const BAG_GLB = `/out/${JOB_CODES.bagModel.replace(/^res\//, '').replace(/\.bsr$/, '.glb')}`

const STAR = '★'
/** A post's corner loads when the player comes this close (m). */
const POST_LOAD_M = 250
const WORLD_EVERY_S = 1

const CSS = `
.entity-label .label-line-job-trader, .entity-label .label-line-job-hunter, .entity-label .label-line-job-thief {
  font-weight: bold; letter-spacing: 0.05em;
  text-shadow: 1px 0 1px #000, -1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000;
}
.entity-label .label-line-job-trader::before, .entity-label .label-line-job-hunter::before, .entity-label .label-line-job-thief::before {
  content: ''; display: inline-block; width: 8px; height: 8px; margin: 0 4px 1px 0; border-radius: 50%;
  vertical-align: middle; box-shadow: 0 0 0 1px #000;
}
.entity-label .label-line-job-trader { color: ${JOB_PLATE_COLOURS.trader}; }
.entity-label .label-line-job-trader::before { background: radial-gradient(circle, #3a240e 0 22%, #e0aa3a 26%); }
.entity-label .label-line-job-hunter { color: ${JOB_PLATE_COLOURS.hunter}; }
.entity-label .label-line-job-hunter::before { background: radial-gradient(circle, #2458b8 0 34%, #dfe6ef 38%); }
.entity-label .label-line-job-thief { color: ${JOB_PLATE_COLOURS.thief}; }
.entity-label .label-line-job-thief::before { background: linear-gradient(135deg, #b31c26 0 40%, #100c0d 42% 52%, #b31c26 54%); }
.entity-label .label-line-job-stars { color: #ffd968; letter-spacing: 0.12em; text-shadow: 0 0 2px #000, 0 1px 1px #000; }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'job-looks'
  s.textContent = CSS
  document.head.append(s)
}

/** The plate's job line text (the i18n format). */
export function jobPlateLine(b: JobBadge | null | undefined): { key: string; text: string } | null {
  return jobPlate(b, (job, level) => t('job.plate', { job, level }))
}

/** Sets a view's job line (clears the other jobs' lines). */
export function applyJobPlate(v: Pick<EntityView, 'setLabelLine'>, b: JobBadge | null | undefined): void {
  const line = jobPlateLine(b)
  for (const k of JOB_PLATE_KEYS) if (k !== line?.key) v.setLabelLine(k, null)
  if (line) v.setLabelLine(line.key, line.text)
}

/** The goods on one transport (crates on its pack saddle, following its pelvis joint): more and bigger with the stars. */
class TransportLoad {
  private readonly bags: TransformNode[] = []
  /** Each bag node's own scaling (its spot through the bind pose), before the stars' size. */
  private readonly baseScale: Vector3[] = []
  private shown = -1
  private stars = 0
  private loading: Promise<TransformNode | null> | null = null
  private disposed = false

  constructor(private readonly v: EntityView) {}

  /** Shows the crates for `stars` (0: none); the bag model loads once. */
  set(stars: number): void {
    const def = TRANSPORT_LOAD[this.v.state.model]
    const actor = this.v.actor
    if (!def || !actor || this.disposed) return
    const n = bundleCount(stars, def.spots.length)
    if (n === this.shown && stars === this.stars) return
    this.shown = n
    this.stars = stars
    void this.build(n)
  }

  private async build(n: number): Promise<void> {
    const actor = this.v.actor
    const def = TRANSPORT_LOAD[this.v.state.model]
    if (!actor || !def) return
    const joint = actor.joint(def.bone)
    if (n > 0 && this.bags.length < n) {
      this.loading ??= loadBag(this.v)
      const src = await this.loading
      if (!src || this.disposed || this.v.actor !== actor) return
      const scene = actor.root.getScene()
      // the spots are in the glb's model space: on the joint through its bind pose (the bag rides with the saddle's
      // gait), else straight under the glTF root
      const bone = joint ? actor.skeleton?.bones.find(b => b.getTransformNode() === joint) : undefined
      const invBind = bone?.getAbsoluteInverseBindMatrix() ?? null
      const parent: Node = invBind && joint ? joint : modelRoot(actor.root)
      for (let i = this.bags.length; i < n; i++) {
        const s = def.spots[i]!
        const node = new TransformNode(`jobBag:${this.v.id}:${i}`, scene)
        const local = Matrix.Compose(new Vector3(s.s, s.s, s.s), Quaternion.FromEulerAngles(0, s.yaw, 0), new Vector3(s.x, s.y, s.z))
        const m = invBind && joint ? local.multiply(invBind) : local
        const sc = new Vector3()
        const rq = new Quaternion()
        const tr = new Vector3()
        m.decompose(sc, rq, tr)
        node.scaling.copyFrom(sc)
        this.baseScale.push(sc.clone())
        node.rotationQuaternion = rq
        node.position.copyFrom(tr)
        node.parent = parent
        const c = src.clone(`jobBagModel:${this.v.id}:${i}`, node, false)
        c?.setEnabled(true)
        for (const m of c?.getChildMeshes(false) ?? []) m.isPickable = false
        this.bags.push(node)
      }
    }
    const k = bundleScale(this.stars)
    for (let i = 0; i < this.bags.length; i++) {
      this.bags[i]!.setEnabled(i < n)
      this.bags[i]!.scaling.copyFrom(this.baseScale[i]!).scaleInPlace(k)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const b of this.bags.splice(0)) b.dispose(false, false)
    this.baseScale.length = 0
  }
}

/** The node the glb's model space hangs under (the glTF `__root__` under the actor root: its handedness flip). */
function modelRoot(root: TransformNode): Node {
  return root.getChildren(n => /__root__$/.test(n.name), true)[0] ?? root
}

/** The goods bag (loaded once per library): a hidden template node (with its glTF root) the crates clone. */
const bagCache = new WeakMap<object, Promise<TransformNode | null>>()
function loadBag(v: EntityView): Promise<TransformNode | null> {
  return loadBagFrom(v.modelLibrary)
}
function loadBagFrom(lib: EntityView['modelLibrary']): Promise<TransformNode | null> {
  let p = bagCache.get(lib)
  if (!p) {
    p = lib
      .load(BAG_GLB)
      .then(l => {
        const r = l.container.instantiateModelsToScene(n => `jobBagSrc:${n}`, false, { doNotInstantiate: true })
        const root = r.rootNodes[0] as TransformNode | undefined
        if (!root) return null
        root.setEnabled(false)
        return root
      })
      .catch(err => {
        console.warn('[jobs] the goods bag model is unavailable', BAG_GLB, err)
        return null
      })
    bagCache.set(lib, p)
  }
  return p
}

export function jobLooksFeature(ctx: WorldFeatureContext): WorldFeature {
  ensureStyles()
  /** Client-side previews (debug): view id → the badge drawn instead of the server's. */
  const loads = new Map<number, TransportLoad>()
  const offs: (() => void)[] = []
  // ---- the posts' dressing and the bags on the ground (world/jobs/trade-world.ts) ----
  const bags = new Map<number, TradeBag>()
  const bagsShown = new Set<number>()
  let tradeWorld: TradeWorldView | null = null
  let worldT = 0
  const syncWorld = () => {
    const g = ctx.world()
    const id = ctx.selfId()
    const me = id === null ? undefined : ctx.view(id)
    if (!g || !me) return
    if (!tradeWorld) {
      const lib = me.modelLibrary
      tradeWorld = new TradeWorldView(ctx.scene, g.world, (x, z) => g.heightAt(x, z), () => loadBagFrom(lib))
    }
    const tw = tradeWorld
    tw.resnap()
    for (const p of JOBS_CONTENT.posts) {
      if (Math.hypot(p.x - me.pos.x, p.z - me.pos.z) <= POST_LOAD_M) void tw.showPost(p.id, p).catch(err => console.warn('[jobs] a trade post failed to dress', p.id, err))
    }
    for (const [bid, b] of bags) {
      if (bagsShown.has(bid)) continue
      bagsShown.add(bid)
      void tw.showBag(b).catch(err => console.warn('[jobs] a goods bag failed to show', bid, err))
    }
    for (const bid of [...bagsShown]) {
      if (bags.has(bid)) continue
      bagsShown.delete(bid)
      tw.hideBag(bid)
    }
  }
  offs.push(() => {
    tradeWorld?.dispose()
    tradeWorld = null
  })
  let frameObs: Observer<Camera> | null = null
  offs.push(() => frameObs && ctx.scene.onBeforeCameraRenderObservable.remove(frameObs))

  offs.push(
    ctx.addAttachment(v => {
      if (v.kind === 'player') {
        let shown = ''
        const apply = () => {
          const j = v.state.job
          const key = j ? `${j.job}${j.level}` : ''
          if (key === shown) return
          shown = key
          applyJobPlate(v, j)
        }
        return { loaded: apply, update: apply, dispose() {} }
      }
      if (v.kind === 'cos' && isTransportCos(v.state.model)) {
        const load = new TransportLoad(v)
        loads.set(v.id, load)
        let shown = -1
        const apply = () => {
          const s = v.state.stars ?? 0
          if (s === shown || !v.actor) return
          shown = s
          load.set(s)
          v.setLabelLine('job-stars', s > 0 ? t('job.transport.stars', { stars: STAR.repeat(Math.min(5, s)) }) : null)
        }
        return {
          loaded: apply,
          update: apply,
          dispose() {
            load.dispose()
            if (loads.get(v.id) === load) loads.delete(v.id)
          },
        }
      }
      return null
    }),
  )

  const debug = {
    /**
     * Dresses a view as if the server said so: `{ job, level }` (own character unless `id`), `{ id, stars }` for a
     * transport, `{ id?, job: null }` back out of job mode.
     */
    preview(p: { id?: number; job?: JobBadge['job'] | null; level?: number; stars?: number } | null): boolean {
      const id = p?.id ?? ctx.selfId()
      const v = id === null || id === undefined ? undefined : ctx.view(id)
      if (!v) return false
      if (p && p.stars !== undefined) {
        if (p.stars > 0) v.state.stars = p.stars
        else delete v.state.stars
        return true
      }
      void v.setJob(p?.job ? { job: p.job, level: p.level ?? 1 } : null)
      return true
    },
    /** Holds the camera on a view (a transport): orbit `alpha`, `beta`, `radius` around its root + `lift` m; null releases it. */
    frame(id: number | null, alpha = 0, beta = 1.3, radius = 6, lift = 1.2): boolean {
      if (frameObs) ctx.scene.onBeforeCameraRenderObservable.remove(frameObs)
      frameObs = null
      if (id === null) return true
      const v = ctx.view(id)
      if (!v) return false
      const c = ctx.camera
      frameObs = ctx.scene.onBeforeCameraRenderObservable.add(() => {
        c.targetScreenOffset.set(0, 0)
        c.target.set(v.root.position.x, v.root.position.y + lift, v.root.position.z)
        c.alpha = alpha
        c.beta = beta
        c.radius = radius
        c.getViewMatrix(true)
      })
      return true
    },
    /** The trade posts dressed and the goods bags drawn. */
    world: () => ({ posts: tradeWorld?.postsShown ?? [], bags: tradeWorld?.bagsShown ?? 0, known: [...bags.values()] }),
    state: () => ({
      members: [...ctx.views()].filter(v => v.kind === 'player' && v.state.job).map(v => ({ id: v.id, name: v.displayName(), job: v.state.job })),
      transports: [...ctx.views()].filter(v => v.kind === 'cos' && isTransportCos(v.state.model)).map(v => ({ id: v.id, model: v.state.model, stars: v.state.stars ?? 0, owner: v.state.owner, x: v.pos.x, z: v.pos.z })),
    }),
  }
  if (typeof window !== 'undefined') (window as unknown as { __sroJobs?: unknown }).__sroJobs = debug

  return {
    onMessage(msg) {
      if (msg.t === 'bag') {
        const { t: _t, ...b } = msg
        bags.set(b.id, b)
        bagsShown.delete(b.id)
        return
      }
      if (msg.t === 'bagGone') {
        bags.delete(msg.id)
        return
      }
      if (msg.t === 'worldLeft') {
        bags.clear()
        bagsShown.clear()
        tradeWorld?.clearBags()
        return
      }
      if (msg.t !== 'entityUpdate') return
      const v = ctx.view(msg.id)
      if (!v) return
      if (msg.job !== undefined) void v.setJob(msg.job)
      if (msg.stars !== undefined) {
        if (msg.stars > 0) v.state.stars = msg.stars
        else delete v.state.stars
      }
    },
    onFrame(_now, dt) {
      worldT -= dt
      if (worldT > 0) return
      worldT = WORLD_EVERY_S
      syncWorld()
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      for (const l of loads.values()) l.dispose()
      loads.clear()
      const w = typeof window !== 'undefined' ? (window as unknown as { __sroJobs?: unknown }) : null
      if (w && w.__sroJobs === debug) delete w.__sroJobs
    },
  }
}
