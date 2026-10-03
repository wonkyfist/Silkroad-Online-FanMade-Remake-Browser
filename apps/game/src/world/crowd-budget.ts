/**
 * The crowd budget (G1 rescue, docs/WAVE_PLAN7.md §5.5 G1: the 20-player plaza and the 20-player world-boss fight at
 * 60 fps on Medium). Twenty player characters near the camera cost what the town, the sky and the post stack cost
 * together: about 8 draws each in the main pass, about 13 more in the two shadow cascades, a skeleton and its clips. So
 * when many characters are near, the OTHER characters get cheaper; the own character, the party members and the current
 * target never do (`keep`), nor anything when only a few are near.
 *
 * - **Shadow casters** (Medium and up, while the preset has sun shadows): the `casters` nearest other characters (by
 *   camera distance) cast into every cascade. The rest cast nothing on Medium and get a soft blob under their feet
 *   (`CharacterBlobs`, one draw for all), or cast into the first cascade only on High and Ultra (their shadow then shows
 *   where the first cascade reaches, near the camera). A caster keeps its place until a non-caster is HYSTERESIS_M
 *   nearer, so two characters at the rank boundary do not trade shadows every refresh. The renderer applies it through
 *   `WorldRender.setCharacterCascades` per character root.
 * - **Animation** (with the animation LOD on, i.e. never on Low: the Low guard): with ANIM_FROM or more other
 *   characters near, an other character beyond CLOSE_M updates its pose at most at the ANIM_TIERS rate for its camera
 *   distance (on top of the size rule of three/models.ts ANIM_LOD, never faster than it). Off screen, an other character
 *   that casts nothing updates at the far off-screen rate whatever its distance ('slow': it throws no shadow into view;
 *   its clip sounds within the 40 m sound range still step), and beyond NEAR_M it freezes ('freeze': nothing of it is
 *   seen or heard; the cull steps it to the current pose the frame it comes back into view).
 * - **Merged parts** (with the animation LOD on, ANIM_FROM or more others near): an other character's glb parts that
 *   draw alike (same material, skin and layout: a Chinese man's face and arms, most monsters' and NPCs' bodies) draw as
 *   one mesh (three/models.ts setMergeParts): the same pixels in fewer draws, so at any distance. At most MERGES_PER_PLAN
 *   new merges per plan (each copies a few thousand vertices); one stays merged until fewer than half of ANIM_FROM
 *   others are near.
 * - **Nothing visible changes within CLOSE_M** but the shadow (no pop at close range: the rate floors start beyond it).
 *
 * The plan is recomputed every PLAN_MS (the casters, the rates); the blobs follow their owners every frame. Low (no new
 * look, the Classic path) has no budget at all: no limits, no blobs, no rate floors.
 */
import type { AbstractMesh } from '@babylonjs/core'
import type { ShadowQuality } from '@sro/world-render'
import type { CharacterActor, CrowdOffscreen } from '../three/models.ts'

/** A preset's shadow rule (crowdPresetFor). */
export interface CrowdShadowRule {
  /** Other characters casting into every cascade at most (the nearest). */
  casters: number
  /** What the rest cast into: 0 nothing, 1 the first cascade only. */
  restCascades: number
  /** The rest that cast nothing get a blob under them. */
  blobs: boolean
}

/**
 * The shadow rule per preset tier, from the shadow block's cascade count (Medium 2, High 3, Ultra 4; an Options
 * override of the shadows row moves with it). Measured on the 20-player plaza (WebGPU Medium, work/tmp/w11-rescue).
 */
export const CROWD_SHADOWS: { readonly medium: CrowdShadowRule; readonly high: CrowdShadowRule } = {
  medium: { casters: 6, restCascades: 0, blobs: true },
  high: { casters: 10, restCascades: 1, blobs: false },
}

/** Other characters this close to the camera count as near (m; the characters' shadow range, CHARACTER_CASTER_M). */
export const NEAR_M = 50
/** The animation rules start with this many other characters near. */
export const ANIM_FROM = 10
/** Within this camera distance (m) the animation of every character stays as it was (no pop at close range). */
export const CLOSE_M = 15
/** Beyond CLOSE_M in a crowd: [up to this camera distance (m), at most this many pose updates per second]. */
export const ANIM_TIERS: ReadonlyArray<readonly [number, number]> = [
  [25, 20],
  [40, 15],
  [Infinity, 10],
]
/** A caster keeps casting until a non-caster is this much nearer (m). */
export const HYSTERESIS_M = 3
/** How often the plan is recomputed (ms). */
export const PLAN_MS = 250
/** New part merges per plan at most (the rest follow on the next plans). */
export const MERGES_PER_PLAN = 4

/** The shadow rule for a preset's shadow block (null: no sun shadows, so no shadow budget). */
export function crowdShadowRule(shadows: Readonly<ShadowQuality> | null | undefined): CrowdShadowRule | null {
  if (!shadows) return null
  return shadows.cascades <= 2 ? CROWD_SHADOWS.medium : CROWD_SHADOWS.high
}

/** The animation rate floor (ms between pose updates; 0 = none) of an other character at camera distance `d`. */
export function crowdAnimMs(d: number): number {
  if (!(d > CLOSE_M)) return 0
  for (const [upTo, hz] of ANIM_TIERS) if (d <= upTo) return 1000 / hz
  return 1000 / ANIM_TIERS[ANIM_TIERS.length - 1]![1]
}

/** One character the plan looks at. */
export interface CrowdEntry {
  /** Camera distance (m). */
  d: number
  /** The own character, a party member or the current target (or what carries one): never budgeted. */
  keep: boolean
  /** It cast into every cascade at the last plan (the hysteresis). */
  wasCasting: boolean
  /** Its parts were merged at the last plan (the merge's hysteresis). */
  wasMerged?: boolean
}

/** What the plan decided for one character. */
export interface CrowdDecision {
  /** Cascades its meshes cast into (Infinity: all, as without the budget). */
  cascades: number
  /** A blob under it (it casts nothing). */
  blob: boolean
  /** Its pose updates at most this often (ms; 0: the actor's own LOD only). */
  animMs: number
  /** Its off-screen rule (three/models.ts CrowdOffscreen). */
  offscreen: CrowdOffscreen
  /** Its alike parts draw merged (three/models.ts setMergeParts). */
  merge: boolean
}

export const FULL: Readonly<CrowdDecision> = { cascades: Infinity, blob: false, animMs: 0, offscreen: 'normal', merge: false }

/**
 * The plan for `entries` (pure; `out[i]` for `entries[i]`). `shadows` null: no shadow budget; `anim` false: no rate
 * floors (the animation LOD is off: Low).
 */
export function planCrowd(entries: readonly CrowdEntry[], shadows: CrowdShadowRule | null, anim: boolean, out: CrowdDecision[] = []): CrowdDecision[] {
  out.length = entries.length
  let near = 0
  for (const e of entries) if (!e.keep && e.d <= NEAR_M) near++
  for (let i = 0; i < entries.length; i++) out[i] = { ...FULL }
  if (shadows) {
    // The others ranked by distance, a caster's own place kept by the hysteresis.
    const others: number[] = []
    for (let i = 0; i < entries.length; i++) if (!entries[i]!.keep) others.push(i)
    if (others.length > shadows.casters) {
      const score = (i: number) => entries[i]!.d - (entries[i]!.wasCasting ? HYSTERESIS_M : 0)
      others.sort((a, b) => score(a) - score(b) || a - b)
      for (let k = shadows.casters; k < others.length; k++) {
        const i = others[k]!
        const o = out[i]!
        o.cascades = shadows.restCascades
        o.blob = shadows.blobs && shadows.restCascades === 0 && entries[i]!.d <= NEAR_M
      }
    }
  }
  if (anim) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      if (e.keep) continue
      const o = out[i]!
      if (near >= ANIM_FROM) o.animMs = crowdAnimMs(e.d)
      o.merge = near >= ANIM_FROM || (!!e.wasMerged && near * 2 >= ANIM_FROM)
      // Off screen and casting nothing: no shadow of it reaches the view, whatever the count; beyond NEAR_M not even its
      // clip sounds are heard (the sound polls entities within 40 m).
      if (o.cascades === 0) o.offscreen = e.d > NEAR_M ? 'freeze' : 'slow'
      else if (e.d > NEAR_M) o.offscreen = 'freeze'
    }
  }
  return out
}

/** What the budget needs from a character view (world/entities.ts EntityView, world/mount-view.ts MountView). */
export interface CrowdView {
  readonly isSelf: boolean
  readonly isDisposed: boolean
  readonly kind: string
  readonly root: { getAbsolutePosition(): { x: number; y: number; z: number } }
  readonly actor: CharacterActor | null
  /** Wave 11: a ridden mob's ride (it leads the rider's animation LOD). */
  readonly ride?: { readonly actor: CharacterActor } | null
  /** A party member (the party feature's name-tag class). */
  readonly partyMate?: boolean
  /** A horse: its rider, and whether the viewer owns it. */
  readonly rider?: CrowdView | null
  readonly own?: boolean
}

/** Where the renderer takes the decisions (World.render; the blob set). */
export interface CrowdRenderer {
  setCharacterCascades?(mesh: AbstractMesh, cascades: number): void
}

/** The blobs under the characters that cast nothing (world-render CharacterBlobs). */
export interface CrowdBlobs {
  begin(): void
  add(x: number, y: number, z: number, radius: number): void
  end(): void
  dispose(): void
}

/** A blob's radius per metre of character height (the town's BLOB_RADIUS_PER_M) and the height assumed without one. */
export const BLOB_RADIUS_PER_M = 0.32
const DEFAULT_HEIGHT_M = 1.8

interface Tracked {
  view: CrowdView
  /** The renderer roots of the view (world/graphics.ts characterMeshes). */
  roots: AbstractMesh[]
  /** Re-reads the roots (after a part merge made or dropped meshes). */
  rescan: (() => void) | null
  decision: CrowdDecision
  /** The cascade count last told to the renderer per root. */
  told: Map<AbstractMesh, number>
  /** The blob's growth 0..1 (a multiply cannot fade: the blob grows in and shrinks out). */
  blobW: number
  height: () => number
}

export interface CrowdBudgetOptions {
  renderer: CrowdRenderer
  /** The camera position (the plan's distances). */
  eye: () => { x: number; y: number; z: number } | null
  /** The current target (kept at full quality). */
  target?: () => CrowdView | null
  /** The preset's shadow block now (null: no shadows). */
  shadows: () => Readonly<ShadowQuality> | null | undefined
  /** The animation LOD is on (the new look; never on Low). */
  anim: () => boolean
  /** The blob set, made on first use (null: none on this path). */
  blobs?: () => CrowdBlobs | null
  now?: () => number
}

/** The budget's runtime: the tracked views, the plan every PLAN_MS, the blobs every frame (WorldGraphics owns one). */
export class CrowdBudget {
  /** On by default; false is the LAB A/B (every character as without the budget). */
  enabled = true
  /** LAB: the shadow rule's caster count override (null: the preset's). */
  castersOverride: number | null = null
  /** LAB: the shadow part and the animation part on their own (the A/B of each). */
  shadowsEnabled = true
  animEnabled = true
  mergeEnabled = true
  private readonly tracked = new Map<CrowdView, Tracked>()
  private next = -Infinity
  private blobSet: CrowdBlobs | null = null
  private readonly entries: CrowdEntry[] = []
  private readonly order: Tracked[] = []
  private decisions: CrowdDecision[] = []
  private lastDt = 0
  private lastAt = Number.NaN
  private readonly now: () => number

  constructor(private readonly o: CrowdBudgetOptions) {
    this.now = o.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()))
  }

  /** Starts budgeting `view` with its renderer roots (again: the roots changed). */
  track(view: CrowdView, roots: readonly AbstractMesh[], height?: () => number, rescan?: () => void): void {
    const had = this.tracked.get(view)
    if (had) {
      if (rescan) had.rescan = rescan
      for (const r of had.roots) if (!roots.includes(r)) this.tell(had, r, Infinity)
      had.roots = [...roots]
      // The renderer forgets a root's count when the root is handed over again (removed and added): tell every root.
      had.told.clear()
      for (const r of had.roots) this.tell(had, r, had.decision.cascades)
      return
    }
    const t: Tracked = { view, roots: [...roots], rescan: rescan ?? null, decision: { ...FULL }, told: new Map(), blobW: 0, height: height ?? (() => DEFAULT_HEIGHT_M) }
    this.tracked.set(view, t)
    this.next = -Infinity
  }

  /** Stops budgeting `view`: its roots cast as without the budget, its actor's rate floor goes. */
  untrack(view: CrowdView): void {
    const t = this.tracked.get(view)
    if (!t) return
    this.tracked.delete(view)
    for (const r of t.roots) this.tell(t, r, Infinity)
    // No re-read of the roots: the view is going (a re-read would hand it to the budget again).
    t.rescan = null
    this.applyAnim(t, FULL, false)
  }

  /** The decision for a view (tests, the LAB). */
  decisionOf(view: CrowdView): Readonly<CrowdDecision> | null {
    return this.tracked.get(view)?.decision ?? null
  }

  /** Views tracked now. */
  get size(): number {
    return this.tracked.size
  }

  /** The views that cast into every cascade, cast into fewer, cast nothing, and the blobs drawn (LAB, tests). */
  stats(): { tracked: number; full: number; limited: number; none: number; blobs: number; floored: number; merged: number } {
    let full = 0
    let limited = 0
    let none = 0
    let floored = 0
    let merged = 0
    for (const t of this.tracked.values()) {
      const c = t.decision.cascades
      if (c === Infinity) full++
      else if (c > 0) limited++
      else none++
      if (t.decision.animMs > 0) floored++
      if (t.view.actor?.mergedParts) merged++
    }
    return { tracked: this.tracked.size, full, limited, none, blobs: this.blobCount, floored, merged }
  }

  private blobCount = 0

  private keep(v: CrowdView): boolean {
    if (v.isSelf || v.partyMate || (this.o.target && this.o.target() === v)) return true
    if (v.own) return true
    const r = v.rider
    return !!r && r !== v && this.keep(r)
  }

  /** Per frame: the plan when due, the blobs always. */
  update(): void {
    const now = this.now()
    this.lastDt = Number.isFinite(this.lastAt) ? Math.min(0.1, Math.max(0, (now - this.lastAt) / 1000)) : 0
    this.lastAt = now
    if (now >= this.next) {
      this.next = now + PLAN_MS
      this.plan()
    }
    this.drawBlobs()
  }

  /** Recomputes the plan now (also when a view is added; tests). */
  plan(): void {
    const eye = this.o.eye()
    const on = this.enabled && !!eye
    let rule = on && this.shadowsEnabled ? crowdShadowRule(this.o.shadows()) : null
    if (rule && this.castersOverride !== null) rule = { ...rule, casters: Math.max(0, this.castersOverride) }
    const anim = on && this.animEnabled && this.o.anim()
    const entries = this.entries
    const order = this.order
    entries.length = 0
    order.length = 0
    for (const t of this.tracked.values()) {
      if (t.view.isDisposed) continue
      const p = t.view.root.getAbsolutePosition()
      const d = eye ? Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z) : 0
      entries.push({ d, keep: this.keep(t.view), wasCasting: t.decision.cascades === Infinity, wasMerged: !!t.view.actor?.mergedParts })
      order.push(t)
    }
    this.decisions = planCrowd(entries, rule, anim, this.decisions)
    let merges = MERGES_PER_PLAN
    for (let i = 0; i < order.length; i++) {
      const t = order[i]!
      const d = this.decisions[i]!
      if (!this.mergeEnabled) d.merge = false
      t.decision = d
      for (const r of t.roots) this.tell(t, r, d.cascades)
      if (this.applyAnim(t, d, merges > 0)) merges--
    }
  }

  private tell(t: Tracked, root: AbstractMesh, cascades: number): void {
    const was = t.told.get(root) ?? Infinity
    if (was === cascades) return
    if (cascades === Infinity) t.told.delete(root)
    else t.told.set(root, cascades)
    this.o.renderer.setCharacterCascades?.(root, cascades)
  }

  /** The actors' rate floor and part merge; true when it built a merge (`mayMerge` false: only drops one). */
  private applyAnim(t: Tracked, d: Readonly<CrowdDecision>, mayMerge: boolean): boolean {
    let built = false
    let changed = false
    // A ridden mob: its ride leads the LOD (the rider copies it), so the ride takes the floor; the rider too, harmless.
    for (const x of [t.view.ride?.actor ?? null, t.view.actor]) {
      // A view without a full actor (a lane test's fake) is left as it is.
      const a = x as Partial<CharacterActor> | null
      if (!a || a.isDisposed || typeof a.setCrowdLod !== 'function' || typeof a.setMergeParts !== 'function') continue
      a.setCrowdLod(d.animMs, d.offscreen)
      if (!!a.mergedParts === d.merge || (d.merge && !mayMerge)) continue
      const v = a.mergeVersion
      if (a.setMergeParts(d.merge)) built = true
      if (a.mergeVersion !== v) changed = true
    }
    // The merged meshes are new renderer roots (and the parts' roots cast nothing while merged): re-read them now.
    if (changed) t.rescan?.()
    return built
  }

  /** The blobs: grow in under a character that casts nothing, shrink out when it casts again (or is gone). */
  private drawBlobs(): void {
    let any = false
    for (const t of this.tracked.values()) {
      const want = t.decision.blob && !t.view.isDisposed && !!t.view.actor
      const step = this.lastDt / 0.3
      t.blobW = want ? Math.min(1, t.blobW + step) : Math.max(0, t.blobW - step)
      if (t.blobW > 0) any = true
    }
    if (!any && !this.blobSet) {
      this.blobCount = 0
      return
    }
    const set = this.blobSet ?? (this.blobSet = this.o.blobs?.() ?? null)
    if (!set) return
    set.begin()
    let n = 0
    for (const t of this.tracked.values()) {
      if (!(t.blobW > 0) || t.view.isDisposed) continue
      const p = t.view.root.getAbsolutePosition()
      const r = Math.max(0.2, t.height() * BLOB_RADIUS_PER_M) * t.blobW
      set.add(p.x, p.y, p.z, r)
      n++
    }
    set.end()
    this.blobCount = n
  }

  /** Makes the blob set now (before play: its warm-up hook compiles it behind the loading picture). */
  prepareBlobs(): void {
    if (!this.blobSet) this.blobSet = this.o.blobs?.() ?? null
  }

  /** The blob set goes (a path switch to Classic, the world's end); it is made again on the next need. */
  dropBlobs(): void {
    this.blobSet?.dispose()
    this.blobSet = null
    this.blobCount = 0
  }

  dispose(): void {
    for (const v of [...this.tracked.keys()]) this.untrack(v)
    this.dropBlobs()
  }
}
