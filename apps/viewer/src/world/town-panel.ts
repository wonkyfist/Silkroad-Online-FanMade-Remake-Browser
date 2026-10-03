// The viewer's town lab (docs/TOWN_LIFE.md §12.2 TL-L, §12.3; docs/WAVE_PLAN7.md §5.4, §6.1 TL-L): a "Town life"
// section in the render lab panel with
// - the counters: World.town's stats (folk drawn / cap / in range, animals, draws, clip writes, update ms, the VAT time,
//   the motion layers' and the dressing's counters) and the roles (agents of each role in the plan, and drawn now);
// - the clock scrub: the town's clock (TownPart.setClock) runs on page time with an offset (−1 h … +1 h), a rate and a
//   freeze, so a position or a clip phase can be held and stepped; the hour buttons set the time of day (who is out);
//   the alarm button starts the 60 s unique alarm (D19) on that clock;
// - the controls the game drives: Town life Off / Low / Full (World.setTownLife, the Options row's call) and the players
//   in range (the cap gives way to them, −3 per player beyond 5, ≥ 15);
// - the rebuild toggle: World.town dropped and made again by the world's own factory (what a Low ↔ Medium switch does);
//   after it the panel checks for leftovers (town meshes no part owns, town materials, a TAA override, the life part's
//   species, and scene counts that grew over an off → on cycle);
// - the A/B: town on (drawn and updated) against off (hidden and skipped) at the current view, with the frame cost
//   (lab-bench.ts's method), the X, Y, X order of the batching lab;
// - the LAB-11 town scenes (WAVE_PLAN7 §5.4 items 1–3 and 6): the viewer runs the ones it can (no server), and
//   `gameScenes()` gives LAB-11's game harness the same spots as /tp lines.
// Idle until used: the panel only installs its clock (page time, offset 0, rate 1: what the part reads without one).
import type { AbstractMesh, Material, Scene } from '@babylonjs/core'
import { createTownPart, formatTime, isTownMesh, type TownFactory, type TownLifeLevel, type TownPart, type World } from '@sro/world-render'
import { worldIdle, type BatchPanelHost } from './batch-panel.ts'
import { benchFrames, gpuSync, yieldTask, type BenchSample } from './lab-bench.ts'

// ---- the LAB-11 town scenes --------------------------------------------------------------------------------------

/** One LAB-11 town scene: the player at (x, z) (glTF metres), the orbit camera around it, the time and the weather. */
export interface TownScene {
  name: string
  label: string
  x: number
  z: number
  /** Orbit angles (rad) and distance (m) around the player's eye (alpha π/2 looks north, −π/2 south, 0 west). */
  alpha: number
  beta: number
  radius: number
  /** Time of day (0..1; 0.5 noon). */
  time: number
  weather: 'clear' | 'storm' | 'rain'
  /** The 60 s unique alarm runs during the measurement (D19). */
  alarm?: boolean
  /** Only the game can run it (bots, mobs or the character stage need the server or the app). */
  gameOnly?: string
  /** Repeats LAB-11 runs (the G1 scene: 4). */
  repeats?: number
}

/**
 * WAVE_PLAN7 §5.4's town scenes (TOWN_LIFE §12.3). The plaza view is LAB-10R's (101, −70 looking north), so the town's
 * delta reads against the wave-10r gate; the market street is the central avenue north of the plaza, where the
 * lantern carriers walk (their route runs 98, −24 → 98, −182) with the tea and iron stalls (145, −130) in range; the
 * gate looks south from inside it (the guard pairs gather at 99, −26). Dusk is 19:00 (the lantern carriers walk 18–20).
 */
export const TOWN_SCENES: readonly TownScene[] = [
  { name: 'plaza-noon', label: 'Plaza, noon (town on / off)', x: 101, z: -70, alpha: Math.PI / 2, beta: 1.2, radius: 12, time: 0.5, weather: 'clear' },
  {
    name: 'plaza-crowd-bots', label: 'Plaza, noon: 20-mob crowd + 20 jumping bots + the town (G1)', x: 101, z: -70, alpha: Math.PI / 2, beta: 1.2,
    radius: 12, time: 0.5, weather: 'clear', gameOnly: 'needs the server (20 monsters, 20 bot players)', repeats: 4,
  },
  { name: 'plaza-night', label: 'Plaza, night (lanterns)', x: 101, z: -70, alpha: Math.PI / 2, beta: 1.2, radius: 12, time: 0.9, weather: 'clear' },
  {
    name: 'market-dusk', label: 'Market street (the central avenue), dusk (lantern carriers)', x: 98, z: -130, alpha: Math.PI / 2, beta: 1.2, radius: 12,
    time: 19 / 24, weather: 'clear',
  },
  { name: 'gate-alarm', label: 'South gate, the 60 s alarm', x: 99, z: -34, alpha: -Math.PI / 2, beta: 1.2, radius: 12, time: 0.5, weather: 'clear', alarm: true },
  {
    name: 'stage', label: 'Character stage: select and create (townsfolk behind, none on the steps)', x: 101, z: -70, alpha: Math.PI / 2, beta: 1.2,
    radius: 12, time: 0.5, weather: 'clear', gameOnly: 'the character stage is the app\'s (stage/host.ts, noFolk)',
  },
]

export function townSceneByName(name: string): TownScene | undefined {
  return TOWN_SCENES.find(s => s.name === name)
}

/** The scenes as LAB-11's game harness takes them (bench10.js's SPOTS: a /tp line, the look, the hour). */
export function gameScenes(): Array<{ name: string; tp: string | null; look: 'north' | 'south' | 'east' | 'west'; beta: number; radius: number; hour: number; weather: string; alarm: boolean; repeats: number; note: string }> {
  const look = (a: number) => (Math.abs(a - Math.PI / 2) < 0.01 ? 'north' : Math.abs(a + Math.PI / 2) < 0.01 ? 'south' : Math.abs(a) < 0.01 ? 'west' : 'east')
  return TOWN_SCENES.map(s => ({
    name: s.name,
    tp: s.name === 'stage' ? null : `/tp ${s.x} ${s.z}`,
    look: look(s.alpha),
    beta: s.beta,
    radius: s.radius,
    hour: Math.round(s.time * 24 * 100) / 100,
    weather: s.weather,
    alarm: !!s.alarm,
    repeats: s.repeats ?? 1,
    note: s.gameOnly ?? '',
  }))
}

// ---- the clock scrub -------------------------------------------------------------------------------------------

/**
 * The town's clock in the viewer (TownClock: server seconds; the viewer has no server, so page time): real time × rate
 * from an anchor, plus a scrub offset; frozen, it holds its second (the offset still moves it).
 */
export class ScrubClock {
  /** The scrub offset (s), added on top. */
  offsetS = 0
  private rateV = 1
  private frozenS: number | null = null
  private anchorReal: number
  private anchorS: number
  /** The TownClock to hand the part (bound once: the part keeps the function). */
  readonly fn = (): number => this.now()

  constructor(private readonly real: () => number = () => Date.now() / 1000) {
    this.anchorReal = this.anchorS = real()
  }

  /** The clock without the offset. */
  private base(): number {
    return this.frozenS ?? this.anchorS + (this.real() - this.anchorReal) * this.rateV
  }

  now(): number {
    return this.base() + this.offsetS
  }

  get rate(): number {
    return this.rateV
  }

  get frozen(): boolean {
    return this.frozenS !== null
  }

  /** Real seconds per real second the clock runs at (from now on; the clock does not jump). */
  setRate(rate: number): void {
    const r = Number.isFinite(rate) && rate >= 0 ? rate : 1
    if (this.frozenS === null) {
      this.anchorS = this.base()
      this.anchorReal = this.real()
    }
    this.rateV = r
  }

  /** Holds the clock at its second (true) or runs it on from there (false). */
  freeze(on: boolean): void {
    if (on === this.frozen) return
    if (on) this.frozenS = this.base()
    else {
      this.anchorS = this.frozenS!
      this.anchorReal = this.real()
      this.frozenS = null
    }
  }

  setOffset(s: number): void {
    this.offsetS = Number.isFinite(s) ? s : 0
  }

  /** Page time again: offset 0, rate 1, running. */
  reset(): void {
    this.offsetS = 0
    this.rateV = 1
    this.frozenS = null
    this.anchorReal = this.anchorS = this.real()
  }
}

// ---- counters --------------------------------------------------------------------------------------------------

/** What the panel reads from TL-C's TownLife beyond the TownPart seam (duck-typed: the class is not exported). */
interface TownView {
  plan?: { folk: { agents: ReadonlyArray<{ role: string }> } } | null
  folk?: { isDrawn(i: number): boolean } | null
  animalSchedule?: { agents: ReadonlyArray<{ role: string }> } | null
  animals?: { isDrawn(i: number): boolean } | null
  setPlayers?(n: number): void
}

export interface RoleCount {
  role: string
  /** Agents of this role in the plan (folk and animals). */
  total: number
  /** Of those, drawn in the last frame. */
  drawn: number
}

/** Agents per role in the town's plan and how many of them are drawn now (most numerous first). */
export function roleCounts(part: TownPart | null): RoleCount[] {
  const t = part as (TownPart & TownView) | null
  const map = new Map<string, RoleCount>()
  const add = (agents: ReadonlyArray<{ role: string }> | undefined, crowd: { isDrawn(i: number): boolean } | null | undefined) => {
    if (!agents) return
    for (let i = 0; i < agents.length; i++) {
      const role = agents[i]!.role
      let c = map.get(role)
      if (!c) map.set(role, (c = { role, total: 0, drawn: 0 }))
      c.total++
      if (crowd?.isDrawn(i)) c.drawn++
    }
  }
  add(t?.plan?.folk.agents, t?.folk)
  add(t?.animalSchedule?.agents, t?.animals)
  return [...map.values()].sort((a, b) => b.total - a.total || a.role.localeCompare(b.role))
}

/** The stats keys the first lines show (the rest are listed as they come: the motion layers', the dressing's). */
const MAIN_KEYS = new Set(['folk', 'animals', 'draws', 'inRange', 'near30', 'cap', 'animalCap', 'players', 'clipWrites', 'updateMs', 'vatTime', 'stub', 'enabled'])

const num = (v: number | undefined, d = 0) => (v === undefined || !Number.isFinite(v) ? '-' : d ? v.toFixed(d) : String(Math.round(v)))

/** The counter lines the panel shows (and `sroWorld.town.counters()` returns). */
export function formatTownCounters(world: World, draws: number, clock?: ScrubClock): string[] {
  const part = world.town
  const lines = [
    `town      ${part ? `part live · ${part.enabled ? 'drawn' : 'off (hidden)'}` : world.render.mode === 'pbr' ? 'no part' : 'Classic (no town: the Low guard)'} · ` +
      `Town life ${world.townLife} · preset ${world.quality}`,
  ]
  if (clock) {
    lines.push(`clock     ${formatTime(world.timeOfDay)} (t ${world.timeOfDay.toFixed(3)}) · server ${clock.now().toFixed(1)} s · offset ${clock.offsetS >= 0 ? '+' : ''}${clock.offsetS.toFixed(0)} s · ` +
      `rate ${clock.rate} · ${clock.frozen ? 'frozen' : 'running'}`)
  }
  if (!part) return lines
  const s = part.stats()
  lines.push(
    `folk      ${num(s.folk)} drawn / cap ${num(s.cap)} · in range ${num(s.inRange)} · within 30 m ${num(s.near30)} · players ${num(s.players)}`,
    `animals   ${num(s.animals)} drawn / cap ${num(s.animalCap)}`,
    `draws     town ${num(s.draws)} of ${draws} · clip writes ${num(s.clipWrites)} · update ${num(s.updateMs, 3)} ms · VAT t ${num(s.vatTime, 1)} s · ` +
      `${s.stub ? 'stand-in assets' : 'TL-V assets'}`,
  )
  const rest = Object.keys(s).filter(k => !MAIN_KEYS.has(k)).map(k => `${k} ${num(s[k], Number.isInteger(s[k]) ? 0 : 2)}`)
  for (let i = 0; i < rest.length; i += 6) lines.push(`${i ? '         ' : 'layers   '} ${rest.slice(i, i + 6).join(' · ')}`)
  const roles = roleCounts(part)
  if (roles.length) {
    const cells = roles.map(r => `${r.role} ${r.drawn}/${r.total}`)
    for (let i = 0; i < cells.length; i += 6) lines.push(`${i ? '         ' : 'roles    '} ${cells.slice(i, i + 6).join(' · ')}`)
  } else lines.push('roles     (no plan yet: no town here, or it is loading)')
  return lines
}

// ---- leftovers -------------------------------------------------------------------------------------------------

export interface TownSceneCounts {
  meshes: number
  materials: number
  textures: number
  geometries: number
  /** The life part's species (the pigeons and ducks are the town's). */
  lifeSpecies: number
}

export function townSceneCounts(scene: Scene, world: World): TownSceneCounts {
  const species = (world.life as unknown as { speciesList?: unknown[] } | null)?.speciesList
  return {
    meshes: scene.meshes.length,
    materials: scene.materials.length,
    textures: scene.textures.length,
    geometries: scene.geometries.length,
    lifeSpecies: species?.length ?? 0,
  }
}

/** What a town rebuild may leave behind. */
export interface TownLeftovers {
  /** World.town is set. */
  part: boolean
  /** Live meshes tagged 'town'. */
  townMeshes: number
  /** Of those, the ones the part does not list nor its assets hold (all of them without a part). */
  strayMeshes: number
  /**
   * Live town meshes drawn (visible, enabled, with instances when thin-instanced), TL-B's dressing layer left out: the
   * decals are the town's beauty, not its life, and stay with Town life Off (as the dressing placements do).
   */
  drawnMeshes: number
  /** TL-B's dressing layer's meshes (decals) drawn now. */
  dressingDrawn: number
  /** Live materials named for the town ('town…') that no world object uses (the dressing props' are the objects'). */
  townMaterials: number
  /** The post stack's temporal override (the town's TAA answer); 'none' without one. */
  temporal: string
}

const isLiveTown = (m: AbstractMesh) => !m.isDisposed() && isTownMesh(m)

function drawn(m: AbstractMesh): boolean {
  if (!m.isVisible || !m.isEnabled()) return false
  const thin = m as AbstractMesh & { hasThinInstances?: boolean; thinInstanceCount?: number }
  return !thin.hasThinInstances || (thin.thinInstanceCount ?? 0) > 0
}

export function findTownLeftovers(scene: Scene, world: World): TownLeftovers {
  const part = world.town
  // The part's meshes, and its assets' variant templates (a variant no crowd uses on this preset stays hidden there).
  const owned = new Set<AbstractMesh>(part?.meshes() ?? [])
  for (const v of (part as unknown as { assets?: { variants?: ReadonlyArray<{ mesh: AbstractMesh }> } | null } | null)?.assets?.variants ?? []) owned.add(v.mesh)
  const dressing = new Set<AbstractMesh>((part as unknown as { dressing?: { meshes(): AbstractMesh[] } | null } | null)?.dressing?.meshes() ?? [])
  const town = scene.meshes.filter(isLiveTown)
  // TL-B's dressing props are world objects (converter placements, `town_*` glb materials): not the part's.
  const placed = new Set<Material>()
  for (const m of scene.meshes) {
    if (m.isDisposed() || isTownMesh(m) || !m.material) continue
    placed.add(m.material)
    for (const sub of (m.material as Material & { subMaterials?: Array<Material | null> }).subMaterials ?? []) if (sub) placed.add(sub)
  }
  return {
    part: !!part,
    townMeshes: town.length,
    strayMeshes: town.filter(m => !owned.has(m)).length,
    drawnMeshes: town.filter(m => drawn(m) && !dressing.has(m)).length,
    dressingDrawn: town.filter(m => drawn(m) && dressing.has(m)).length,
    townMaterials: scene.materials.filter(m => /^town/i.test(m.name) && !placed.has(m)).length,
    temporal: (world.render.post as { temporalOverride?: string } | null)?.temporalOverride ?? 'none',
  }
}

/**
 * The problems in `l` (empty: clean). `on`: the town is wanted (a part live and enabled); off: no part, or a part with
 * Town life Off (`hidden`), which keeps its meshes but draws none.
 */
export function townLeftoverProblems(l: Readonly<TownLeftovers>, state: 'on' | 'hidden' | 'gone'): string[] {
  const out: string[] = []
  if (l.strayMeshes) out.push(`${l.strayMeshes} town mesh(es) owned by no part`)
  if (state === 'on') return out
  if (state === 'hidden') {
    if (l.drawnMeshes) out.push(`${l.drawnMeshes} town mesh(es) still drawn with Town life off`)
    if (l.temporal !== 'none') out.push(`the TAA override (${l.temporal}) still held with Town life off`)
    return out
  }
  if (l.part) out.push('World.town is still set')
  if (l.townMeshes) out.push(`${l.townMeshes} town mesh(es) left without a part`)
  if (l.townMaterials) out.push(`${l.townMaterials} town material(s) left without a part`)
  if (l.temporal !== 'none') out.push(`the TAA override (${l.temporal}) still held without a part`)
  return out
}

/** Scene counts that grew between two visits of the same state (`before` → `after`): a leak per cycle. */
export function townCountGrowth(before: Readonly<TownSceneCounts>, after: Readonly<TownSceneCounts>): string[] {
  return (Object.keys(before) as (keyof TownSceneCounts)[]).filter(k => after[k] > before[k]).map(k => `${k} ${before[k]} → ${after[k]}`)
}

// ---- the rebuild -----------------------------------------------------------------------------------------------

/** The factory the world was loaded with (LoadWorldOptions.parts.town; private there), else TL-C's default. */
function townFactory(world: World): TownFactory | null {
  const parts = (world as unknown as { parts?: { town?: TownFactory | null } }).parts
  return parts && parts.town !== undefined ? parts.town : createTownPart
}

/**
 * Drops World.town (off) or makes it again with the world's own factory (on), as a render-path switch does
 * (World.syncTown), with the world's Town life level and `clock`. On the Classic path there is never a part (the Low
 * guard): `on` is refused there. Returns the part now live.
 */
export function rebuildTown(world: World, on: boolean, clock: (() => number) | null = null): TownPart | null {
  if (!on) {
    const t = world.town
    world.town = null
    t?.dispose()
    return null
  }
  if (world.town) return world.town
  if (world.render.mode !== 'pbr') return null
  const part = townFactory(world)?.({ scene: world.scene, world }) ?? null
  if (!part) return null
  world.town = part
  world.setTownLife(world.townLife)
  part.setClock(clock)
  return part
}

// ---- the panel -------------------------------------------------------------------------------------------------

export interface TownToggleReport {
  on: boolean
  ms: number
  leftovers: TownLeftovers
  problems: string[]
  counts: TownSceneCounts
}

export interface TownAbResult {
  scene: string
  preset: string
  backend: string
  draws: { off: number; on: number }
  /** The town's own counters with it on. */
  town: { folk: number; animals: number; draws: number; updateMs: number }
  bench: { off: BenchSample | null; on: BenchSample | null }
  problems: string[]
}

const PLAYER_STEPS = [0, 5, 10, 15, 20] as const
const HOURS = [0, 6, 9, 12, 18, 19, 21] as const
const LEVELS: readonly TownLifeLevel[] = ['off', 'low', 'full']

/**
 * The Town life section of the render lab (mounted into `#render-panel`) and, as `window.sroWorld.town`, a console
 * handle: toggle(on), level(l), players(n), alarm(), ab({ bench }), scene(name), benchScenes(), counters(),
 * gameScenes(), clock.
 */
export class TownPanel {
  readonly clock = new ScrubClock()
  private readonly out: HTMLPreElement
  private readonly info: HTMLPreElement
  private readonly toggleBox: HTMLInputElement
  private readonly levelSel: HTMLSelectElement
  private readonly offset: HTMLInputElement
  private readonly offsetOut: HTMLOutputElement
  private readonly freezeBox: HTMLInputElement
  private wired: TownPart | null = null
  private playersN = 0
  private busy = false
  /** The last results (console / the report). */
  readonly results: { toggles: TownToggleReport[]; ab: TownAbResult[] } = { toggles: [], ab: [] }

  constructor(readonly root: HTMLElement, readonly host: BatchPanelHost) {
    const d = document.createElement('details')
    d.className = 'town-panel'
    const s = document.createElement('summary')
    s.textContent = 'Town life (TL-L)'
    this.info = document.createElement('pre')
    this.info.className = 'lab-out'
    this.out = document.createElement('pre')
    this.out.className = 'lab-out'

    const row = document.createElement('div')
    row.className = 'row'
    const label = document.createElement('label')
    this.toggleBox = document.createElement('input')
    this.toggleBox.type = 'checkbox'
    this.toggleBox.checked = !!host.world.town
    this.toggleBox.addEventListener('change', () => void this.toggle(this.toggleBox.checked))
    label.append(this.toggleBox, ' Town part (rebuild)')
    this.levelSel = document.createElement('select')
    this.levelSel.title = 'Options → Graphics → Town life (World.setTownLife)'
    for (const l of LEVELS) this.levelSel.appendChild(new Option(`Town life ${l}`, l))
    this.levelSel.value = host.world.townLife
    this.levelSel.addEventListener('change', () => this.level(this.levelSel.value as TownLifeLevel))
    const players = document.createElement('select')
    players.title = 'Player characters in the crowd\'s range (the cap gives way: −3 per player beyond 5, ≥ 15)'
    for (const n of PLAYER_STEPS) players.appendChild(new Option(`${n} players`, String(n)))
    players.addEventListener('change', () => this.players(Number(players.value)))
    row.append(label, this.levelSel, players)

    // The clock scrub: offset, rate, freeze; the hours set the time of day.
    const clockRow = document.createElement('label')
    clockRow.className = 'row'
    clockRow.title = 'The town clock (server seconds): page time + this offset'
    clockRow.textContent = 'Clock'
    this.offset = document.createElement('input')
    this.offset.type = 'range'
    this.offset.min = '-3600'
    this.offset.max = '3600'
    this.offset.step = '1'
    this.offset.value = '0'
    this.offsetOut = document.createElement('output')
    this.offset.addEventListener('input', () => this.scrub(Number(this.offset.value)))
    clockRow.append(this.offset, this.offsetOut)
    const clockChecks = document.createElement('div')
    clockChecks.className = 'lab-checks'
    const freeze = document.createElement('label')
    this.freezeBox = document.createElement('input')
    this.freezeBox.type = 'checkbox'
    this.freezeBox.addEventListener('change', () => this.clock.freeze(this.freezeBox.checked))
    freeze.append(this.freezeBox, ' Freeze')
    const rate = document.createElement('select')
    rate.title = 'Clock rate (the walk and the clips run this much faster)'
    for (const r of [0.25, 1, 4, 16]) rate.appendChild(new Option(`×${r}`, String(r)))
    rate.value = '1'
    rate.addEventListener('change', () => this.clock.setRate(Number(rate.value)))
    clockChecks.append(freeze, rate)
    const hours = document.createElement('div')
    hours.className = 'lab-buttons'
    for (const h of HOURS) hours.appendChild(btn(`${String(h).padStart(2, '0')}:00`, () => this.host.controls.setTime(h / 24), `time of day ${h}:00 (who is out)`))
    hours.append(
      btn('Now', () => {
        this.clock.reset()
        this.freezeBox.checked = false
        rate.value = '1'
        this.scrub(0)
      }, 'the clock back to page time'),
      btn('Alarm 60 s', () => this.alarm(), 'the unique\'s appear alarm (D19): walkers hurry indoors, guards to the south gate'),
    )

    const scenes = document.createElement('select')
    scenes.title = 'LAB-11 town scene (the player moves there; time, weather and the alarm follow)'
    scenes.appendChild(new Option('scene…', ''))
    for (const sc of TOWN_SCENES) {
      const o = new Option(sc.gameOnly ? `${sc.label} [game]` : sc.label, sc.name)
      o.disabled = !!sc.gameOnly
      scenes.appendChild(o)
    }
    scenes.addEventListener('change', () => {
      if (scenes.value) void this.scene(scenes.value)
      scenes.value = ''
    })
    const buttons = document.createElement('div')
    buttons.className = 'lab-buttons'
    buttons.append(
      btn('A/B here', () => void this.ab(), 'town on vs off at this view: draws and the town\'s counters'),
      btn('A/B + bench', () => void this.ab({ bench: true }), 'the A/B with the frame cost of each state (lab-bench.ts method)'),
      btn('All scenes', () => void this.benchScenes(), 'the A/B with the bench at every viewer scene'),
    )
    d.append(s, row, clockRow, clockChecks, hours, scenes, buttons, this.info, this.out)
    root.appendChild(d)
    this.scrub(0)
    this.wire()
    window.setInterval(() => {
      this.wire()
      if (d.open) this.renderInfo()
    }, 250)
  }

  get world(): World {
    return this.host.world
  }

  counters(): string[] {
    return formatTownCounters(this.world, this.host.draws(), this.clock)
  }

  gameScenes(): ReturnType<typeof gameScenes> {
    return gameScenes()
  }

  /** Hands the clock and the players to a part the world made (load, a path switch, the rebuild). */
  private wire(): void {
    const t = this.world.town
    if (t === this.wired) return
    this.wired = t
    if (!t) return
    t.setClock(this.clock.fn)
    ;(t as TownPart & TownView).setPlayers?.(this.playersN)
  }

  private renderInfo(): void {
    this.toggleBox.checked = !!this.world.town
    this.toggleBox.disabled = this.busy || this.world.render.mode !== 'pbr'
    this.levelSel.value = this.world.townLife
    this.info.textContent = this.counters().join('\n')
  }

  private scrub(s: number): void {
    this.clock.setOffset(s)
    this.offset.value = String(s)
    const m = Math.round(Math.abs(s) / 60)
    this.offsetOut.textContent = `${s < 0 ? '−' : '+'}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  }

  private log(s: string): void {
    console.info('[town-lab]', s)
    this.out.textContent = `${this.out.textContent ? this.out.textContent + '\n' : ''}${s}`.split('\n').slice(-40).join('\n')
    this.out.scrollTop = this.out.scrollHeight
  }

  level(l: TownLifeLevel): void {
    this.world.setTownLife(l)
    this.log(`Town life ${l}`)
  }

  players(n: number): void {
    this.playersN = Math.max(0, Math.floor(n) || 0)
    ;(this.world.town as (TownPart & TownView) | null)?.setPlayers?.(this.playersN)
  }

  alarm(sec = 60): void {
    const t = this.world.town
    if (!t) return this.log('no town part: no alarm')
    t.alarm(this.clock.now(), sec)
    this.log(`alarm for ${sec} s from ${this.clock.now().toFixed(1)}`)
  }

  private frame(): void {
    const e = this.host.engine
    e.beginFrame()
    this.host.scene.render()
    e.endFrame()
  }

  /** Renders frames until streaming is idle and the town's plan and assets are in (at least `min` frames), at most `maxMs`. */
  async settleWorld(min = 30, maxMs = 60_000): Promise<boolean> {
    const t0 = performance.now()
    let calm = 0
    for (let i = 0; performance.now() - t0 < maxMs; i++) {
      this.frame()
      await yieldTask()
      calm = worldIdle(this.world) && townIdle(this.world.town) ? calm + 1 : 0
      if (i >= min && calm >= 10) {
        await gpuSync(this.host.engine)
        return true
      }
    }
    return false
  }

  private async run<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.busy) {
      this.log(`busy: ${what} skipped`)
      return null
    }
    this.busy = true
    this.host.pause()
    try {
      return await fn()
    } catch (err) {
      this.log(`${what} failed: ${String((err as Error)?.stack ?? err)}`)
      return null
    } finally {
      this.host.resume()
      this.busy = false
    }
  }

  /** Drops World.town (off) or makes it again (on), renders to idle, then the leftover check. */
  toggle(on: boolean): Promise<TownToggleReport | null> {
    return this.run('toggle', () => this.toggleNow(on))
  }

  private async toggleNow(on: boolean): Promise<TownToggleReport> {
    const t0 = performance.now()
    rebuildTown(this.world, on, this.clock.fn)
    this.wire()
    const idle = await this.settleWorld()
    const leftovers = findTownLeftovers(this.host.scene, this.world)
    const state = !this.world.town ? 'gone' : this.world.town.enabled ? 'on' : 'hidden'
    const problems = townLeftoverProblems(leftovers, state)
    if (on && !this.world.town && this.world.render.mode === 'pbr') problems.push('no town part was made')
    if (!idle) problems.push('the world did not go idle in 60 s')
    const r: TownToggleReport = { on, ms: Math.round(performance.now() - t0), leftovers, problems, counts: townSceneCounts(this.host.scene, this.world) }
    this.results.toggles.push(r)
    this.log(`town part ${on ? 'on' : 'off'} in ${r.ms} ms · ${problems.length ? 'LEFTOVERS: ' + problems.join('; ') : 'no leftovers'} · ` +
      `${r.counts.meshes} meshes, ${r.counts.materials} materials, ${r.counts.textures} textures, ${r.counts.lifeSpecies} life species`)
    return r
  }

  /** Moves to a LAB-11 town scene (time, weather, camera, the alarm) and waits until the world is idle. */
  scene(name: string): Promise<TownScene | null> {
    return this.run('scene', async () => {
      const s = townSceneByName(name)
      if (!s) throw new Error(`no town scene '${name}'`)
      if (s.gameOnly) throw new Error(`'${name}' runs in the game only: ${s.gameOnly}`)
      await this.gotoScene(s)
      return s
    })
  }

  private async gotoScene(s: TownScene): Promise<void> {
    this.host.controls.setTime(s.time)
    this.host.controls.setWeather(s.weather === 'clear' ? null : s.weather)
    this.host.goto(s.x, s.z, s.alpha, s.beta, s.radius)
    await this.settleWorld(60)
    // The alarm last (it runs 60 s from now; the A/B and its bench fit inside it).
    if (s.alarm) this.alarm(60)
    this.log(`scene ${s.label}`)
  }

  /** The A/B at the current view (or `scene`): town on (drawn and updated) against off (hidden and skipped). */
  ab(o: { bench?: boolean; scene?: string } = {}): Promise<TownAbResult | null> {
    return this.run('A/B', async () => {
      if (o.scene) {
        const s = townSceneByName(o.scene)
        if (!s || s.gameOnly) throw new Error(`no viewer town scene '${o.scene}'`)
        await this.gotoScene(s)
      }
      return this.abNow(o.scene ?? 'here', !!o.bench)
    })
  }

  /** The A/B with the bench at every scene the viewer can run (WAVE_PLAN7 §5.4 items 1 and 3). */
  benchScenes(): Promise<TownAbResult[] | null> {
    return this.run('bench', async () => {
      const out: TownAbResult[] = []
      for (const s of TOWN_SCENES) {
        if (s.gameOnly) continue
        await this.gotoScene(s)
        out.push(await this.abNow(s.name, true))
      }
      this.log(formatTownAb(out))
      return out
    })
  }

  private async abNow(label: string, bench: boolean): Promise<TownAbResult> {
    const t = this.world.town
    if (!t) throw new Error('the A/B needs a town part (the PBR path, Town part on)')
    const was = t.enabled
    const problems: string[] = []
    try {
      const state = async (on: boolean) => {
        t.setEnabled(on)
        await this.settleWorld()
        const l = findTownLeftovers(this.host.scene, this.world)
        problems.push(...townLeftoverProblems(l, on ? 'on' : 'hidden').map(p => `${on ? 'on' : 'off'}: ${p}`))
        const draws = this.host.draws()
        const st = t.stats()
        const town = { folk: st.folk ?? 0, animals: st.animals ?? 0, draws: st.draws ?? 0, updateMs: st.updateMs ?? 0 }
        let sample: BenchSample | null = null
        if (bench) sample = await benchFrames(this.benchHost(), `${label}-town-${on ? 'on' : 'off'}`, { frames: 120, runs: 3 })
        return { draws, town, sample }
      }
      // X, Y, X again (X = the state the page was in), as the batching lab: the repeat spans the same time as the A/B.
      const x1 = await state(was)
      const y = await state(!was)
      const x2 = await state(was)
      const on = was ? x1 : y
      const off = was ? y : x1
      if (Math.abs(x2.draws - x1.draws) > Math.max(4, x1.draws * 0.05)) problems.push(`draws drifted ${x1.draws} → ${x2.draws} between the two ${was ? 'on' : 'off'} captures`)
      const r: TownAbResult = {
        scene: label,
        preset: String(this.world.quality),
        backend: this.host.engine.isWebGPU ? 'WebGPU' : 'WebGL2',
        draws: { off: off.draws, on: on.draws },
        town: on.town,
        bench: { off: off.sample, on: on.sample },
        problems,
      }
      this.results.ab.push(r)
      this.log(formatTownAb([r]))
      return r
    } finally {
      if (t.enabled !== was) t.setEnabled(was)
    }
  }

  private benchHost() {
    // benchFrames pauses and resumes the page loop itself: the panel already holds it paused.
    return { engine: this.host.engine, scene: this.host.scene, world: this.world, pause() {}, resume() {} }
  }
}

/** True when the town's plan and assets are in (or there is no town, or it has nothing to load). */
export function townIdle(part: TownPart | null): boolean {
  if (!part) return true
  const p = (part as unknown as { pending?: boolean }).pending
  return p !== true
}

/** One line per A/B (the panel, the console; LAB-11's results table takes the same columns). */
export function formatTownAb(rows: readonly TownAbResult[]): string {
  const ms = (s: BenchSample | null) => (s ? `${s.wallMs.toFixed(2)}/${s.cpuMs.toFixed(2)}${s.gpuPassMs !== null ? `/${s.gpuPassMs.toFixed(2)}` : ''}` : '-')
  const d = (a: BenchSample | null, b: BenchSample | null) => (a && b ? ` (Δ cpu ${(b.cpuMs - a.cpuMs >= 0 ? '+' : '')}${(b.cpuMs - a.cpuMs).toFixed(2)})` : '')
  return rows.map(r =>
    `${r.scene} [${r.backend} ${r.preset}]: draws ${r.draws.off} → ${r.draws.on} · town folk ${r.town.folk}, animals ${r.town.animals}, ` +
    `${r.town.draws} draws, update ${r.town.updateMs.toFixed(3)} ms · wall/cpu/gpu ms off ${ms(r.bench.off)} → on ${ms(r.bench.on)}${d(r.bench.off, r.bench.on)}` +
    (r.problems.length ? ` · PROBLEMS ${r.problems.join('; ')}` : ''),
  ).join('\n')
}

function btn(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = text
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
