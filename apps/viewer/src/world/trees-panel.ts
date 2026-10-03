// The viewer's trees lab (docs/TREES.md Part W, §W4.1 rule 3, §W11 T12-L; docs/WAVE_PLAN8.md §6.2 T12-L).
// Step 1: the crown A/B method, shared by the lab harness (work/tmp/trees/t12l-lab, a port of work/tmp/trees/w12/lab):
// - the bench views of the four B1 families (the game camera: fov 0.85, beta 1.2–1.36, target at a player's eye);
// - `crownLuma`: TREES fact-check W WF1's crown_luma method. Over the pixels that differ between a retail frame and a
//   new-trees frame of the same camera, the green crown pixels' mean luminance and saturation, per frame; the gate is
//   the ratio new / retail within ±10 % (§W4.1 rule 3).
// - the A/Bs of rule 3 (a) the retail sprite keys with their TX-R map sets, (b) the card-normal rule, (c) the foliage
//   translucency on / off, each one a pair of frames measured with crownLuma.
// Step 2: the panel (a section of the render panel; idle until used, so without a parameter nothing changes):
// - `?trees=new|retail`: the tree mode at load (LoadWorldOptions.trees; main.ts passes it), and the New / Retail toggle
//   (World.setTreeMode: the batch and the trees part made again, the streamed regions rebuilt). After a toggle the
//   panel waits for the streamer and checks the scene for leftovers (`findTreeLeftovers`): no overlay mesh or material,
//   no band texture and no banded merged vertex without the part; no overlay mesh the part does not own with it.
// - the band view (`?bands=1`): a marker over every swapped placement (its bounding sphere's top) in its band's colour:
//   near green (the LOD0 overlay), mid yellow (the merged LOD1), far red (LOD2), hidden grey (the editor's band 3).
//   Its own debug meshes (StandardMaterial, WGSL on WebGPU), never the world's materials.
// - the counters: the trees part's stats() (slots, bands, the overlay, the refill, the crowded-plaza rule).
import { Color3, MeshBuilder, StandardMaterial, type AbstractMesh, type Mesh, type Scene } from '@babylonjs/core'
import type { TreesMode, TreesPart, World } from '@sro/world-render'

/** One crown bench view: the orbit camera around (x, y, z) (glTF metres): alpha, beta (rad), radius (m). */
export interface CrownView {
  t: readonly [number, number, number]
  a: number
  b: number
  r: number
}

/** The B1 families' crown views (TREES §W5.2, the prototype lab's; the game camera's fov 0.85). */
export const CROWN_VIEWS: Readonly<Record<'maple' | 'shrub' | 'willow' | 'pine', CrownView>> = {
  maple: { t: [70, -2, -50], a: -2.6, b: 1.22, r: 38 },
  shrub: { t: [126, -4, -137], a: 1.57, b: 1.2, r: 16 },
  willow: { t: [188, 0, -205], a: -0.5, b: 1.25, r: 40 },
  pine: { t: [364, 16, 930], a: -1.57, b: 1.36, r: 85 },
}

/** The ±10 % crown luminance gate (TREES §W4.1 rule 3, WAVE_PLAN8 §5 "Tree look gates"). */
export const CROWN_GATE = 0.1

/** A pixel differs between the frames when |ΔR| + |ΔG| + |ΔB| exceeds this (0..3; WF1's 0.08). */
export const CROWN_DIFF = 0.08

export interface CrownStat {
  /** Mean Rec. 709 luminance (0..1) of the crown pixels. */
  luma: number
  /** Mean HSV saturation (0..1). */
  sat: number
  /** Crown pixels counted. */
  px: number
}

export interface CrownResult {
  retail: CrownStat
  next: CrownStat
  /** next.luma / retail.luma (NaN when either frame has no crown pixel). */
  ratio: number
  /** Within the ±10 % gate. */
  pass: boolean
}

/** A green crown pixel: G above B by 15 % and G at least 0.8 R (WF1's mask, keeps the red maple's olive leaves). */
function green(r: number, g: number, b: number): boolean {
  return g > b * 1.15 && g >= r * 0.8
}

function stat(px: ArrayLike<number>, mask: Uint8Array): CrownStat {
  let n = 0, l = 0, s = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const r = px[i * 4]! / 255, g = px[i * 4 + 1]! / 255, b = px[i * 4 + 2]! / 255
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    l += 0.2126 * r + 0.7152 * g + 0.0722 * b
    s += (mx - mn) / Math.max(mx, 1e-6)
    n++
  }
  return { luma: n ? l / n : NaN, sat: n ? s / n : NaN, px: n }
}

/**
 * WF1's crown luminance A/B over two RGBA8 frames of the same size and camera (retail first): the pixels that differ
 * (CROWN_DIFF), each frame's green ones, their mean luminance and saturation, and the ratio new / retail.
 */
export function crownLuma(retail: ArrayLike<number>, next: ArrayLike<number>, pixels: number): CrownResult {
  if (retail.length < pixels * 4 || next.length < pixels * 4) throw new Error('crownLuma: frames smaller than the pixel count')
  const ma = new Uint8Array(pixels), mb = new Uint8Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    const ar = retail[o]! / 255, ag = retail[o + 1]! / 255, ab = retail[o + 2]! / 255
    const br = next[o]! / 255, bg = next[o + 1]! / 255, bb = next[o + 2]! / 255
    if (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb) <= CROWN_DIFF) continue
    if (green(ar, ag, ab)) ma[i] = 1
    if (green(br, bg, bb)) mb[i] = 1
  }
  const a = stat(retail, ma), b = stat(next, mb)
  const ratio = b.luma / a.luma
  return { retail: a, next: b, ratio, pass: Number.isFinite(ratio) && Math.abs(ratio - 1) <= CROWN_GATE }
}

/** Flips an RGBA8 frame read bottom-up (WebGL readPixels) to top-down rows, in place. */
export function flipRows(px: Uint8Array, width: number, height: number): Uint8Array {
  const row = width * 4, tmp = new Uint8Array(row)
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row, b = (height - 1 - y) * row
    tmp.set(px.subarray(a, a + row))
    px.copyWithin(a, b, b + row)
    px.set(tmp, b)
  }
  return px
}

// ---- step 2: the panel -------------------------------------------------------------------------------------------

/** The band bytes (world-render trees/bands.ts BAND_NEAR … BAND_HIDDEN; the panel reads them, never writes them). */
export const BAND_NAMES: readonly string[] = ['near', 'mid', 'far', 'hidden']

/** The band view's colours: near green, mid yellow, far red, hidden grey. */
export const BAND_COLOURS: readonly (readonly [number, number, number])[] = [[0.15, 1, 0.3], [1, 0.85, 0.15], [1, 0.25, 0.2], [0.55, 0.55, 0.6]]

export interface TreesLabParams {
  /** `?trees=new|retail` (null: the default, 'new'). */
  mode: TreesMode | null
  /** `?bands=1`: start with the band view on. */
  bands: boolean
}

/** `?trees=`, `?bands=1`. */
export function parseTreesParams(search: string): TreesLabParams {
  const p = new URLSearchParams(search)
  const t = p.get('trees')
  return { mode: t === 'new' || t === 'retail' ? t : null, bands: p.get('bands') === '1' }
}

/** One swapped placement as the band view reads it (world-render trees/bands.ts SlotEntry: its sphere and band). */
export interface SlotLike {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly r: number
  readonly band: number
}

/** The trees part's slot table (T12-N's TreesNearField.slots), duck-typed: the part interface does not expose it. */
function slotsOf(part: TreesPart | null): Iterable<SlotLike> | null {
  const slots = (part as unknown as { slots?: { entries?: () => Iterable<SlotLike> } } | null)?.slots
  return typeof slots?.entries === 'function' ? slots.entries() : null
}

/** Why the swap does or does not apply now (the counters' first line). */
export function treesState(world: World): string {
  const mode = world.treeMode
  if (world.trees) return `${mode} (swapping)`
  if (mode === 'retail') return 'retail'
  if (world.render.mode !== 'pbr') return 'new, not applied: the Classic path draws retail (the Low guard)'
  if (!world.stream) return 'new, not applied: the whole world is loaded (no streamer, no region batch)'
  if (!world.batching) return 'new, not applied: World batching is off'
  return 'new, not applied: no region batch'
}

/** The marker matrices of each band (a size from the sphere, at the sphere's top) and the counts: the band view's fill. */
export function bandMarkers(entries: Iterable<SlotLike>): { counts: number[]; matrices: Float32Array[] } {
  const lists: number[][] = [[], [], [], []]
  for (const e of entries) {
    const b = e.band >= 0 && e.band <= 3 ? e.band : 3
    const s = Math.min(2, Math.max(0.5, e.r * 0.12))
    lists[b]!.push(s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, e.x, e.y + e.r, e.z, 1)
  }
  return { counts: lists.map(l => l.length / 16), matrices: lists.map(l => Float32Array.from(l)) }
}

/** The band view: four thin-instanced markers (one per band), the lab's own meshes and materials. */
export class BandView {
  private readonly meshes: Mesh[] = []
  private readonly mats: StandardMaterial[] = []
  counts = [0, 0, 0, 0]

  constructor(readonly scene: Scene) {
    BAND_COLOURS.forEach(([r, g, b], i) => {
      const mat = new StandardMaterial(`treesLab:band${i}`, scene)
      mat.disableLighting = true
      mat.emissiveColor = new Color3(r, g, b)
      mat.diffuseColor = Color3.Black()
      mat.specularColor = Color3.Black()
      mat.fogEnabled = false
      mat.metadata = { sroTreesLab: true }
      const mesh = MeshBuilder.CreatePolyhedron(`treesLab:band${i}`, { type: 1, size: 1 }, scene)
      mesh.material = mat
      mesh.isPickable = false
      mesh.alwaysSelectAsActiveMesh = true
      mesh.metadata = { sroTreesLab: true }
      mesh.thinInstanceSetBuffer('matrix', new Float32Array(16), 16, false)
      mesh.thinInstanceCount = 0
      mesh.isVisible = false
      this.meshes.push(mesh)
      this.mats.push(mat)
    })
  }

  /** Refills the markers from the trees part (none when there is no part: retail, Classic, batching off). */
  sync(part: TreesPart | null): void {
    const { counts, matrices } = bandMarkers(slotsOf(part) ?? [])
    this.counts = counts
    this.meshes.forEach((m, i) => {
      const n = counts[i]!
      if (n) m.thinInstanceSetBuffer('matrix', matrices[i]!, 16, false)
      m.thinInstanceCount = n
      m.isVisible = n > 0
    })
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose()
    for (const m of this.mats) m.dispose()
    this.meshes.length = 0
    this.mats.length = 0
  }
}

// ---- the leftovers check -----------------------------------------------------------------------------------------

export interface TreeLeftovers {
  /** World.trees is set. */
  part: boolean
  /** Live LOD0 overlay meshes (metadata.sroTreeOverlay). */
  overlayMeshes: number
  /** …of which the part does not own (all of them without a part). */
  strayOverlay: number
  /** Live overlay materials (metadata.sroTreeOverlay). */
  overlayMaterials: number
  /** The foliage plugins still hold a band texture (SRO_FOL_BAND on). */
  bandTexture: boolean
  /** Merged vertices whose pivot word carries a tier (a swapped species' LOD1 / LOD2: slot × 4 + tier). */
  bandedVertices: number
}

const meta = (o: { metadata?: unknown }): Record<string, unknown> | null => (o.metadata as Record<string, unknown> | null) ?? null

/** What the trees part left in the scene (or holds there): see TreeLeftovers. */
export function findTreeLeftovers(scene: Scene, world: World): TreeLeftovers {
  const part = world.trees
  const owned = new Set<AbstractMesh>(part?.meshes() ?? [])
  const overlay = scene.meshes.filter(m => !m.isDisposed() && !!meta(m)?.sroTreeOverlay)
  let banded = 0
  for (const m of scene.meshes) {
    const md = meta(m)
    if (m.isDisposed() || !md?.sroTree || md.sroTreeOverlay) continue
    const vb = (m as Mesh).getVertexBuffer?.('sroPivot')
    if (!vb || vb.getSize() !== 4) continue
    const data = (m as Mesh).getVerticesData('sroPivot')
    if (!data) continue
    for (let i = 3; i < data.length; i += 4) if ((Math.round(data[i]!) & 3) !== 0) banded++
  }
  const shared = (world.foliage as unknown as { shared?: { band?: unknown } } | null)?.shared
  return {
    part: !!part,
    overlayMeshes: overlay.length,
    strayOverlay: overlay.filter(m => !owned.has(m)).length,
    overlayMaterials: scene.materials.filter(m => !!meta(m)?.sroTreeOverlay).length,
    bandTexture: !!shared?.band,
    bandedVertices: banded,
  }
}

/** The problems in `l` (empty: clean). `swapping`: the trees part should be live (the swap applies). */
export function treeLeftoverProblems(l: Readonly<TreeLeftovers>, swapping: boolean): string[] {
  const out: string[] = []
  if (l.strayOverlay) out.push(`${l.strayOverlay} overlay mesh(es) owned by no part`)
  if (swapping) {
    if (!l.part) out.push('World.trees is not set')
    return out
  }
  if (l.part) out.push('World.trees is still set')
  if (l.overlayMaterials) out.push(`${l.overlayMaterials} overlay material(s) left without a part`)
  if (l.bandTexture) out.push('the band texture is still on the foliage plugins')
  if (l.bandedVertices) out.push(`${l.bandedVertices} banded merged vertices without a part`)
  return out
}

/** Scene counts (a leak shows as growth between two visits of the same mode). */
export interface TreeSceneCounts {
  meshes: number
  materials: number
  textures: number
  geometries: number
}

/** The scene's counts, without the band view's own meshes and materials. */
export function treeSceneCounts(scene: Scene): TreeSceneCounts {
  const mine = (o: { metadata?: unknown }) => !!meta(o)?.sroTreesLab
  return {
    meshes: scene.meshes.filter(m => !mine(m)).length,
    materials: scene.materials.filter(m => !mine(m)).length,
    textures: scene.textures.length,
    geometries: scene.geometries.length,
  }
}

/** The counts that grew between two visits of the same mode (`before` → `after`). */
export function treeCountGrowth(before: Readonly<TreeSceneCounts>, after: Readonly<TreeSceneCounts>): string[] {
  return (Object.keys(before) as (keyof TreeSceneCounts)[]).filter(k => after[k] > before[k]).map(k => `${k} ${before[k]} → ${after[k]}`)
}

// ---- the counters ------------------------------------------------------------------------------------------------

const n0 = (s: Readonly<Record<string, number>>, k: string): number => s[k] ?? 0

/** The panel's counter lines for a world (the part's stats(); `bands`: the band view's marker counts, or null). */
export function formatTreesCounters(world: World, bands: readonly number[] | null = null): string[] {
  const lines = [`trees     ${treesState(world)}`]
  const part = world.trees
  if (!part) return lines
  const s = part.stats()
  const loading = n0(s, 'speciesLoading'), failed = n0(s, 'speciesFailed')
  lines.push(
    `slots     ${n0(s, 'slots')} used · ${n0(s, 'slotsFree')} free · ${n0(s, 'slotsRefused')} refused · placed ${n0(s, 'placed')} · freed ${n0(s, 'freed')}`,
    `bands     near ${n0(s, 'band0')} · mid ${n0(s, 'band1')} · far ${n0(s, 'band2')} · hidden ${n0(s, 'band3')}`,
    `overlay   ${n0(s, 'overlayDraws')} draws · ${n0(s, 'overlayInstances')} instances · ${n0(s, 'overlayMeshes')} meshes · species ` +
      `${n0(s, 'speciesReady')}/${n0(s, 'species')} ready${loading ? ` (${loading} loading)` : ''}${failed ? ` (${failed} failed)` : ''}`,
    `refill    ${n0(s, 'refills')} · last ${n0(s, 'refillMs').toFixed(2)} ms · worst ${n0(s, 'refillMaxMs').toFixed(2)} ms · uploads ${n0(s, 'bandUploads')}`,
    `crowd     ${n0(s, 'crowded') ? 'on (overlay within 20 m)' : 'off'} · players ${n0(s, 'players')} · editor hidden ${n0(s, 'hidden')} · previews ${n0(s, 'previews')}`,
  )
  if (bands) lines.push(`band view ${bands.map((c, i) => `${BAND_NAMES[i]} ${c}`).join(' · ')}`)
  return lines
}

// ---- the toggle --------------------------------------------------------------------------------------------------

export interface TreesToggleReport {
  mode: TreesMode
  /** The synchronous part of World.setTreeMode (the release and the new batch; the regions rebuild afterwards). */
  ms: number
  /** Until the streamer was idle again (the regions re-merged), or -1 (not within the timeout). */
  settleMs: number
  leftovers: TreeLeftovers
  problems: string[]
}

/** The streamer has nothing left to do: every wanted region in, with its objects (no streamer: true). */
export function streamIdle(world: World): boolean {
  const s = world.stream?.stats
  return !s || (s.ready >= s.wanted && s.objectsReady >= s.ready && s.jobs === 0 && s.fetching === 0)
}

/** Switches the tree mode (World.setTreeMode) and times its synchronous part (ms). */
export function switchTrees(world: World, mode: TreesMode): number {
  const t0 = performance.now()
  world.setTreeMode(mode)
  return performance.now() - t0
}

/**
 * The panel's toggle: switches, waits (polling `wait`) until the streamer is idle (≤ `timeoutMs`), then checks the
 * scene for leftovers against what the mode should give.
 */
export async function toggleTrees(world: World, mode: TreesMode, wait: () => Promise<void>, timeoutMs = 60_000): Promise<TreesToggleReport> {
  const ms = switchTrees(world, mode)
  const t0 = performance.now()
  let settleMs = -1
  // Idle twice in a row: the rebuild's first frames can still read idle before its regions are queued again.
  let idle = 0
  while (performance.now() - t0 < timeoutMs) {
    await wait()
    idle = streamIdle(world) ? idle + 1 : 0
    if (idle >= 2) {
      settleMs = performance.now() - t0
      break
    }
  }
  const leftovers = findTreeLeftovers(world.scene, world)
  // The swap applies where World made a trees part for the mode (PBR, streamed, batching on, 'new').
  const swapping = mode === 'new' && !!world.batch
  return { mode, ms, settleMs, leftovers, problems: treeLeftoverProblems(leftovers, swapping) }
}

/** One line for a toggle report. */
export function formatTreesToggle(r: Readonly<TreesToggleReport>): string {
  const l = r.leftovers
  return `toggle    → ${r.mode} in ${r.ms.toFixed(1)} ms, regions ${r.settleMs >= 0 ? `${(r.settleMs / 1000).toFixed(1)} s` : 'not settled'} · ` +
    `overlay ${l.overlayMeshes} · banded ${l.bandedVertices} · band tex ${l.bandTexture ? 'on' : 'off'} · ` +
    (r.problems.length ? `PROBLEMS: ${r.problems.join('; ')}` : 'no leftovers')
}

/** The panel (a section of the render panel; see the file comment). */
export class TreesPanel {
  private view: BandView | null = null
  private last: TreesToggleReport | null = null
  private busy = false
  private readonly out: HTMLPreElement
  private readonly sel: HTMLSelectElement

  constructor(parent: HTMLElement, private readonly world: World, params: TreesLabParams) {
    const d = document.createElement('details')
    const s = document.createElement('summary')
    s.textContent = 'Trees (T12-L)'
    d.appendChild(s)
    parent.appendChild(d)
    const row = document.createElement('label')
    row.className = 'row'
    row.textContent = 'Trees'
    this.sel = document.createElement('select')
    for (const [v, text] of [['new', 'New'], ['retail', 'Retail']] as const) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = text
      this.sel.appendChild(o)
    }
    this.sel.value = world.treeMode
    this.sel.addEventListener('change', () => void this.toggle(this.sel.value === 'retail' ? 'retail' : 'new'))
    row.appendChild(this.sel)
    d.appendChild(row)
    const checks = document.createElement('div')
    checks.className = 'lab-checks'
    const l = document.createElement('label')
    const c = document.createElement('input')
    c.type = 'checkbox'
    c.checked = params.bands
    c.addEventListener('change', () => this.setBandView(c.checked))
    l.append(c, ' Band view (near green, mid yellow, far red, hidden grey)')
    checks.appendChild(l)
    d.appendChild(checks)
    this.out = document.createElement('pre')
    this.out.className = 'lab-out'
    d.appendChild(this.out)
    if (params.bands) {
      d.open = true
      this.setBandView(true)
    }
    window.setInterval(() => {
      this.view?.sync(this.world.trees)
      if (d.open) this.render()
    }, 250)
  }

  /** The band view on or off (its meshes made / disposed). */
  setBandView(on: boolean): void {
    if (on && !this.view) {
      this.view = new BandView(this.world.scene)
      this.view.sync(this.world.trees)
    } else if (!on && this.view) {
      this.view.dispose()
      this.view = null
    }
  }

  /** New / Retail: World.setTreeMode and the URL's `trees`, then the leftovers check once the regions are in again. */
  async toggle(mode: TreesMode): Promise<TreesToggleReport | null> {
    if (this.busy) return null
    this.busy = true
    this.sel.disabled = true
    try {
      const url = new URL(location.href)
      url.searchParams.set('trees', mode)
      history.replaceState(null, '', url)
      this.last = null
      this.out.textContent = `switching to ${mode}…`
      this.last = await toggleTrees(this.world, mode, () => new Promise(r => window.setTimeout(r, 100)))
      this.view?.sync(this.world.trees)
      if (this.last.problems.length) console.warn('[trees] toggle leftovers:', this.last.problems)
      return this.last
    } finally {
      this.busy = false
      this.sel.disabled = false
      this.sel.value = this.world.treeMode
      this.render()
    }
  }

  private render(): void {
    const lines = formatTreesCounters(this.world, this.view?.counts ?? null)
    if (this.last) lines.push(formatTreesToggle(this.last))
    this.out.textContent = lines.join('\n')
  }
}
