/**
 * The World Editor page (docs/WORLD_EDITOR.md §2, §4, §5, §7.1; docs/WAVE_PLAN8.md lane WE-U): the game's own renderer
 * (`loadWorld`: PBR, streaming, region batching, the new grass, the ocean, the town, the sky) on the export, with the
 * user's tools: Raise / Lower / Smooth / Flatten / Noise, texture Paint, Grass and flowers, Place / Move / Turn /
 * Resize / Delete with ground snap, multi-select, copy / paste, undo / redo, revert one change or a region, Save; the
 * plain-English status line, the budget line, the minimap and the walking overlay. It renders on demand (D47).
 *
 * URL: editor.html?world=jangan-fields&k=<token>[&preset=high|medium|low][&at=x,z][&t=0.42][&engine=webgl]
 * Opened without a token but with `at=x,z` (the game's /editmap link, D5) it only asks the open editor tab to fly
 * there. `pnpm editor` (lane WE-A) starts it on 127.0.0.1:5185 with the local editor API (api.ts).
 */
import {
  ArcRotateCamera, Color3, Matrix, PointerEventTypes, Scene, Vector3, WebGPUEngine,
  type AbstractEngine, type ArcRotateCameraPointersInput, type Ray,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF/2.0/index.js'
import { Assets, formatTime, grassFieldOf, loadWorld, type World, type WorldQuality } from '@sro/world-render'
import { paintWord, walkRefusalSentence } from '../../../../packages/shared/src/world-edits/index.ts'
import { createEngine } from '../engine.ts'
import { Player } from '../world/player.ts'
import { EditorApi, FLY_CHANNEL, type FlyMessage } from './api.ts'
import { budgetText, regionBudget } from './budget.ts'
import { FLOWER_KIND, type GrassMode } from './grass-edits.ts'
import { grassLabel, heightLabel, objectLabel, paintLabel, regionName, setDisplayNames, walkLabel, type Change } from './history.ts'
import { keyGX, keyGZ } from './lattice.ts'
import { MinimapView } from './minimap-view.ts'
import { isDressingRef } from './object-edits.ts'
import { ObjectsView, type GizmoMode } from './objects-view.ts'
import { BrushRing, WalkOverlay } from './overlays.ts'
import { tilingCodes } from './paint-edits.ts'
import { paletteEntries, validatePalette, type PaletteEntry, type PaletteFile, type PbrIndexLike } from './palette.ts'
import { LIBRARY_TABS, type LibraryTab } from './place-list.ts'
import {
  LibraryThumbs, TREE_LIBRARY_URL, TreeLook, buildLibrary, fetchTreeLibrary, filterLibrary, installLibraryCss, renderLibraryRow,
  type EditorLibrary,
} from './library/index.ts'
import { HttpPublishBackend, PublishFlow, TestInGame, type GameWindow, type PublishBackend, type TakenShot } from './publish.ts'
import { PublishPanel } from './publish-panel.ts'
import { RegionNames, escapeHtml, reportModel, sheetViews, type PublishRunView, type SheetView, type TestInGameView } from './publish-report.ts'
import { RenderGate, ViewWatch } from './render-gate.ts'
import { ShadowBaker } from './shadow-bake.ts'
import { EditSession } from './session.ts'
import { CoastGuard, type HeightTool } from './terrain-edits.ts'
import type { WalkMode } from './walk-edits.ts'
import { WorldLink } from './world-link.ts'
import { TownPreview } from './town/town-preview.ts'
import { TownTool } from './town/town-tool.ts'

const q = new URLSearchParams(location.search)
const WORLD = (q.get('world') || 'jangan-fields').replace(/[^a-z0-9-]/g, '')
const PRESET = (['high', 'medium', 'low'] as const).find(p => p === q.get('preset')) ?? 'high'
const AT = (q.get('at') ?? '').split(',').map(Number)
const HAS_AT = AT.length === 2 && AT.every(Number.isFinite)
const BASE = '/out/'
const WORLD_URL = `${BASE}world/${WORLD}/`

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

// ---- tools -------------------------------------------------------------------------------------------------------------

type Tool = 'move' | 'place' | HeightTool | 'paint' | 'grass' | 'walk' | 'water' | 'light' | 'sound' | 'route'
interface ToolDef {
  id: Tool
  icon: string
  name: string
  key: string
  /** Why it is not here yet (dimmed with this tooltip). */
  later?: string
}
const TOOLS: Array<ToolDef | null> = [
  { id: 'move', icon: '✥', name: 'Move', key: 'V' },
  { id: 'place', icon: '✚', name: 'Place', key: 'O' },
  null,
  { id: 'raise', icon: '▲', name: 'Raise', key: 'B' },
  { id: 'lower', icon: '▼', name: 'Lower', key: 'N' },
  { id: 'smooth', icon: '≈', name: 'Smooth', key: 'S' },
  { id: 'flatten', icon: '▬', name: 'Flatten', key: 'F' },
  { id: 'noise', icon: '∿', name: 'Noise', key: 'J' },
  null,
  { id: 'paint', icon: '■', name: 'Paint', key: 'P' },
  { id: 'grass', icon: '❦', name: 'Grass', key: 'H' },
  null,
  { id: 'walk', icon: '⛝', name: 'Walkable', key: 'Y' },
  { id: 'water', icon: '≋', name: 'Water', key: 'U', later: 'Ponds and water levels come in a later build step.' },
  { id: 'light', icon: '☀', name: 'Lights', key: 'L', later: 'Light points come in a later build step.' },
  { id: 'sound', icon: '♪', name: 'Sound', key: 'Z', later: 'Sound zones come in a later build step.' },
  { id: 'route', icon: '⤳', name: 'Routes', key: 'T' },
]
const HEIGHT_TOOLS: readonly Tool[] = ['raise', 'lower', 'smooth', 'flatten', 'noise']
const BRUSH_TOOLS: readonly Tool[] = [...HEIGHT_TOOLS, 'paint', 'grass', 'walk']
const toolDef = (t: Tool) => TOOLS.find(x => x?.id === t)!

const KEYS: Record<string, string> = {
  move: '<span><kbd>Click</kbd>select</span><span><kbd>Shift</kbd>/<kbd>Ctrl</kbd>+click add / remove</span><span><kbd>Drag</kbd>select many</span><span><kbd>W</kbd>move <kbd>E</kbd>turn <kbd>R</kbd>resize</span><span><kbd>G</kbd>snap to ground</span><span><kbd>Del</kbd>delete</span><span><kbd>Ctrl</kbd>held: keep the height</span><span><kbd>Ctrl</kbd><kbd>C</kbd>/<kbd>V</kbd>copy / paste</span><span><kbd>Esc</kbd>deselect</span>',
  place: '<span><kbd>Click</kbd>put it there</span><span><kbd>Wheel</kbd>turn it</span><span><kbd>Shift</kbd>+click keep placing</span><span><kbd>Esc</kbd>stop</span>',
  height: '<span><kbd>Left-drag</kbd>shape the ground</span><span><kbd>Shift</kbd>reverse</span><span><kbd>[</kbd><kbd>]</kbd>size</span><span><kbd>-</kbd><kbd>=</kbd>strength</span><span><kbd>Esc</kbd>cancel the stroke</span>',
  flatten: '<span><kbd>Left-drag</kbd>flatten to the height where you start</span><span><kbd>Alt</kbd>+click pick a height</span><span><kbd>[</kbd><kbd>]</kbd>size</span><span><kbd>-</kbd><kbd>=</kbd>strength</span>',
  paint: '<span><kbd>Left-drag</kbd>paint the ground</span><span><kbd>Shift</kbd>+drag original ground</span><span><kbd>Alt</kbd>+click pick the ground under the cursor</span><span><kbd>[</kbd><kbd>]</kbd>size</span><span><kbd>-</kbd><kbd>=</kbd>strength</span>',
  grass: '<span><kbd>Left-drag</kbd>paint grass</span><span><kbd>Shift</kbd>+drag original grass</span><span><kbd>[</kbd><kbd>]</kbd>size</span><span><kbd>-</kbd><kbd>=</kbd>strength</span>',
  walk: '<span><kbd>Left-drag</kbd>open / close the ground for walking</span><span><kbd>Shift</kbd>+drag the other one</span><span><kbd>[</kbd><kbd>]</kbd>size</span><span><kbd>Esc</kbd>cancel the stroke</span>',
  common: '<span><kbd>Right-drag</kbd>look around</span><span><kbd>Right</kbd>+<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> fly, <kbd>Q</kbd>/<kbd>E</kbd> down / up</span><span><kbd>Middle-drag</kbd>pan</span><span><kbd>Wheel</kbd>zoom</span><span><kbd>Ctrl</kbd><kbd>Z</kbd>/<kbd>Y</kbd>undo / redo</span><span><kbd>Ctrl</kbd><kbd>S</kbd>save</span><span><kbd>M</kbd>map</span><span><kbd>F1</kbd>help</span>',
}

// ---- the page --------------------------------------------------------------------------------------------------------------

let tool: Tool = 'raise'
let world: World
let scene: Scene
let cam: ArcRotateCamera
let session: EditSession
let link: WorldLink
let objects: ObjectsView
/** The Routes tool (WE-T: town/) and the crowd that walks its file. */
let town: TownTool | null = null
/** GH-2: the regions' lightmaps baked again after object and ground edits (the converter's bake in a worker). */
let shadows: ShadowBaker | null = null
const townPreview = new TownPreview()
let ring: BrushRing
let walk: WalkOverlay
let minimap: MinimapView | null = null
let api: EditorApi
const gate = new RenderGate()
const viewWatch = new ViewWatch()
let readOnly = false
let painting: 'height' | 'paint' | 'grass' | 'walk' | null = null
let paintReverse = false
let lastHit: Vector3 | null = null
let lastStamp = 0
let rmbHeld = false
let ctrlHeld = false
const held = new Set<string>()
let paintTile: PaletteEntry | null = null
let palette: PaletteEntry[] = []
let tiling: { forTile(tile: number): number } = { forTile: () => 0 }
let grassMode: GrassMode = 'less'
/** The Walkable brush's mode (the panel's Open / Close / Auto; Shift swaps Open and Close for one stroke). */
let walkBrush: WalkMode = 'open'
/** The region under the camera when the walking overlay was last rebuilt around it (the Walkable tool). */
let walkAround = -1
let walkLive = 0
let library: EditorLibrary
let thumbs: LibraryThumbs | null = null
let placeTab: LibraryTab | 'All' = 'All'
let placeSource: string | null = null
let rectStart: { x: number; y: number } | null = null
let lastSavedAt = 0
let draws = 0
const stampStats = { n: 0, ms: 0, worst: 0 }
/** "Walk here" (§2.4): the viewer's adventurer on the previewed nav. */
let walkMode = false
let walker: Player | null = null
let walkerLoading = false
const errors: string[] = []
/** Publish… and Test in game (publish.ts), the report panel, the regions' names for it. */
let publish: PublishFlow
let tester: TestInGame
let panel: PublishPanel
let names = new RegionNames()
let backend: PublishBackend
/** The edits taken out while the page shows the original map (the before pictures); null: the edits are on. */
let hidden: ReturnType<EditSession['hideEdits']> | null = null

/** Why nothing can be edited now (a read-only tab, the original map on screen), or null. */
function locked(): string | null {
  if (readOnly) return 'This tab is read-only: another World Editor tab is open.'
  if (hidden) return 'You are looking at the original map: press Original again to see and edit your changes.'
  return null
}

function say(text: string, kind: 'ok' | 'warn' | 'error' = 'ok'): void {
  const el = $('msg')
  el.textContent = text
  el.className = kind === 'ok' ? '' : kind
  if (kind === 'error') console.warn('[editor]', text)
}

const size = () => Number($<HTMLInputElement>('size').value)
const strength = () => Number($<HTMLInputElement>('str').value) / 100
const softness = () => Number($<HTMLInputElement>('soft').value) / 100
const brushParams = () => ({ radiusM: size() / 2, strength: strength(), softness: softness() })

function syncSliders(): void {
  $('sizeV').textContent = `${size()} m`
  $('strV').textContent = `${Math.round(strength() * 100)} %`
  $('softV').textContent = `${Math.round(softness() * 100)} %`
  if (painting === 'height') session.heights.setParams(brushParams())
  if (painting === 'paint') session.paint.setParams(brushParams())
  if (painting === 'grass') session.grass.setParams(brushParams())
  if (painting === 'walk') session.walk.setRadius(size() / 2)
  showRing()
}

/** The Walkable brush's mode for a stroke (Shift: the other of Open / Close). */
const walkStrokeMode = (shift: boolean): WalkMode => (shift && walkBrush === 'open' ? 'close' : shift && walkBrush === 'close' ? 'open' : walkBrush)

function buildTools(): void {
  const el = $('tools')
  el.innerHTML = ''
  for (const t of TOOLS) {
    if (!t) {
      const g = document.createElement('div')
      g.className = 'g'
      el.appendChild(g)
      continue
    }
    const d = document.createElement('div')
    d.className = `t${t.id === tool ? ' on' : ''}${t.later ? ' off' : ''}`
    d.title = t.later ? `${t.name} (${t.key}): ${t.later}` : `${t.name} (${t.key})`
    d.innerHTML = `<span class="k">${t.key}</span><span class="i">${t.icon}</span><span class="n">${t.name}</span>`
    d.onclick = () => setTool(t.id)
    el.appendChild(d)
  }
}

function setTool(t: Tool): void {
  const def = toolDef(t)
  if (def.later) return say(`${def.name}: ${def.later}`, 'warn')
  if (painting) endStroke()
  if (t !== 'place') objects?.cancelGhost()
  if (t !== 'move' && t !== 'place' && objects?.selection.length) void objects.deselect()
  tool = t
  buildTools()
  const brush = BRUSH_TOOLS.includes(t)
  $('brush').classList.toggle('hidden', !brush)
  $('brushTool').textContent = brush ? def.name : ''
  $('flattenRow').classList.toggle('hidden', t !== 'flatten')
  $('grassModes').classList.toggle('hidden', t !== 'grass')
  $('walkModes').classList.toggle('hidden', t !== 'walk')
  $('walkNote').classList.toggle('hidden', t !== 'walk')
  // the Walkable brush has a hard edge and no strength: only the size applies
  $('strRow').classList.toggle('hidden', t === 'walk')
  $('softRow').classList.toggle('hidden', t === 'walk')
  $('followRow').classList.toggle('hidden', !HEIGHT_TOOLS.includes(t))
  $('selected').classList.toggle('hidden', t !== 'move')
  $('palette').classList.toggle('hidden', t !== 'paint')
  $('place').classList.toggle('hidden', t !== 'place')
  $('changes').classList.toggle('hidden', t === 'paint' || t === 'place')
  $('keys').innerHTML = (t === 'move' ? KEYS.move : t === 'place' ? KEYS.place : t === 'flatten' ? KEYS.flatten : t === 'paint' ? KEYS.paint : t === 'grass' ? KEYS.grass : t === 'walk' ? KEYS.walk : KEYS.height) + KEYS.common
  showRing()
  if (t === 'move') say('Move: click a rock, tree or prop to pick it up; drag on empty ground to select many.')
  else if (t === 'place') say(placeSource ? 'Place: click the ground to put it there.' : 'Place: pick a model in the list on the right, then click the ground.')
  else if (t === 'paint') say(paintTile ? `Paint: drag to paint ${paintTile.title}. Shift + drag brings back the original ground.` : 'Paint: pick a ground texture on the right, then drag on the ground.')
  else if (t === 'grass') say('Grass: drag to change the grass. Pick Less, More, Flowers or Original on the right.')
  else if (t === 'walk') say(`Walkable: drag over red tiles to open them for walking (Open), or to keep players off (Close); Shift + drag does the other one. Size ${size()} m.`)
  else if (t !== 'route') say(`${def.name}: drag on the ground. Size ${size()} m, strength ${Math.round(strength() * 100)} %.`)
  if (t === 'route') $('keys').innerHTML = TownTool.keys + KEYS.common
  town?.setActive(t === 'route')
  // the Walkable tool shows the walking tiles around the camera too (not only where you edited)
  if (walk && (t === 'walk') !== (walkAround >= 0)) {
    walkAround = -1
    refreshWalk()
  }
  gate.invalidate()
}

// ---- ground ------------------------------------------------------------------------------------------------------------

/** The edited heightfield under a ray (the client nav keeps the old heights until Publish, so not world.pick). */
function groundHit(ray: Ray): Vector3 | null {
  const o = ray.origin, d = ray.direction
  let prev = 0
  for (let t = 0.5; t < 1500; t += t < 100 ? 0.5 : t < 400 ? 2 : 6) {
    const x = o.x + d.x * t, z = o.z + d.z * t, y = o.y + d.y * t
    const h = world.regions.heightAt(x, z)
    if (h !== null && y <= h) {
      let a = prev, b = t
      for (let i = 0; i < 18; i++) {
        const m = (a + b) / 2
        const hm = world.regions.heightAt(o.x + d.x * m, o.z + d.z * m) ?? -1e9
        if (o.y + d.y * m <= hm) b = m
        else a = m
      }
      return new Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b)
    }
    prev = t
  }
  return null
}

const ground = (x: number, z: number) => world.regions.heightAt(x, z)

function showRing(): void {
  if (!ring) return
  if (!BRUSH_TOOLS.includes(tool) || !lastHit) return ring.show(null, 0, 0)
  if (tool === 'walk') {
    // hard edge; green opens, red closes, grey gives the tiles back to the automatic rule
    const m = painting === 'walk' ? walkStrokeMode(paintReverse) : walkBrush
    const colour = m === 'open' ? new Color3(0.3, 1, 0.45) : m === 'close' ? new Color3(1, 0.3, 0.25) : new Color3(0.8, 0.8, 0.8)
    ring.show({ x: lastHit.x, z: lastHit.z }, size() / 2, 0, colour)
    return gate.invalidate()
  }
  const colour = paintReverse || (tool === 'lower') ? new Color3(0.6, 0.85, 1) : new Color3(1, 0.82, 0.35)
  ring.show({ x: lastHit.x, z: lastHit.z }, size() / 2, softness(), colour)
  gate.invalidate()
}

// ---- strokes -------------------------------------------------------------------------------------------------------------

function beginStroke(shift: boolean): void {
  if (locked()) return say(locked()!, 'warn')
  if (!lastHit) return
  paintReverse = shift
  if (HEIGHT_TOOLS.includes(tool)) {
    const kind = tool === 'raise' && shift ? 'lower' : tool === 'lower' && shift ? 'raise' : (tool as HeightTool)
    const ft = $<HTMLInputElement>('flattenTo').value
    session.heights.begin(kind, brushParams(), { seed: session.history.peekId(), ...(tool === 'flatten' && ft !== '' ? { flattenTo: Number(ft) } : {}) })
    painting = 'height'
  } else if (tool === 'paint') {
    if (!paintTile && !shift) return say('Pick a ground texture on the right first.', 'warn')
    const word = shift || !paintTile ? -1 : paintWord(paintTile.tile, tiling.forTile(paintTile.tile))
    session.paint.begin(word, brushParams())
    painting = 'paint'
  } else if (tool === 'grass') {
    if (!grassFieldOf(world.scatter)) say('Grass painting shows on Medium and High (Low draws the old grass). Your strokes are still kept.', 'warn')
    session.grass.begin(shift ? 'clear' : grassMode, brushParams(), FLOWER_KIND)
    painting = 'grass'
  } else if (tool === 'walk') {
    session.walk.begin(walkStrokeMode(shift), size() / 2)
    painting = 'walk'
    session.walk.takeDirty()
    showRing()
  }
  lastStamp = 0
  stampNow()
}

function stampNow(): void {
  if (!painting || !lastHit) return
  const t0 = performance.now()
  if (painting === 'height') {
    const r = session.heights.stamp(lastHit.x, lastHit.z)
    if (r.clamped) say('Stopped at the shore: the sea floor can\'t rise above the water here, and the shore can\'t sink under it.', 'warn')
  } else if (painting === 'paint') session.paint.stamp(lastHit.x, lastHit.z)
  else if (painting === 'walk') {
    session.walk.stamp(lastHit.x, lastHit.z)
    walkLiveUpdate()
  } else session.grass.stamp(lastHit.x, lastHit.z)
  const ms = performance.now() - t0
  stampStats.n++
  stampStats.ms += ms
  stampStats.worst = Math.max(stampStats.worst, ms)
  lastStamp = performance.now()
}

function cancelStroke(): void {
  if (painting === 'height') session.heights.cancel()
  else if (painting === 'paint') session.paint.cancel()
  else if (painting === 'grass') session.grass.cancel()
  else if (painting === 'walk') {
    session.walk.cancel()
    walkLiveUpdate(true)
  }
  painting = null
  say('Stroke cancelled.')
}

function endStroke(): void {
  const kind = painting
  painting = null
  if (kind === 'height') {
    const c = session.heights.end()
    if (!c) return
    const box = keysBox(c.keys)
    const parts: Parameters<EditSession['record']>[0] = { height: c }
    let extra = ''
    if ($<HTMLInputElement>('follow').checked) {
      const items = objects.followGround(box)
      if (items.length) {
        for (const it of items) session.objects.set(it.ref, it.after)
        parts.objects = { items }
        extra = ` ${items.length} ${items.length === 1 ? 'object follows' : 'objects follow'} the ground.`
      }
    }
    const blockers = objects.blockersIn(box)
    if (blockers) extra += ` ${blockers} building${blockers === 1 ? '' : 's'} stand${blockers === 1 ? 's' : ''} on changed ground: check ${blockers === 1 ? 'it' : 'them'} (Publish lists them).`
    const ch = session.record(parts, heightLabel(session.heights.tool, c), c.regions)
    link.afterHeights(c.regions, box)
    if (parts.objects) void link.syncObjects()
    const closed = refreshWalk(c.regions)
    say(`${ch.label}.${extra}${closed ? ` ${closed} tiles became too steep to walk (over 35°): players walk around them. Smooth the sides if they should climb it.` : ''} Not saved yet.`, closed ? 'warn' : 'ok')
  } else if (kind === 'paint') {
    const c = session.paint.end()
    if (!c) return
    const ch = session.record({ paint: c }, paintLabel(c.tile >= 0 ? (palette.find(p => p.tile === c.tile)?.title ?? `tile ${c.tile}`) : null, c), c.regions)
    say(`${ch.label}. Not saved yet.`)
  } else if (kind === 'grass') {
    const c = session.grass.end()
    if (!c) return
    const ch = session.record({ grass: c }, grassLabel(c), c.regions)
    say(`${ch.label}. Not saved yet.`)
  } else if (kind === 'walk') {
    const c = session.walk.end()
    // the hard limits: tiles this stroke could not open (outside the bounds, in the sea, under a building or object)
    const why = walkRefusalSentence(session.walk.refused)
    session.walk.takeDirty()
    showRing()
    if (!c) {
      refreshWalk()
      if (why) say(why, 'warn')
      return
    }
    const ch = session.record({ walk: c }, walkLabel(c), c.regions)
    link.refreshNav(c.regions)
    refreshWalk(c.regions)
    say(`${ch.label}.${why ? ` ${why}` : ''} Not saved yet.`, why ? 'warn' : 'ok')
  }
  renderChanges()
}

/** The glTF box of a stroke's lattice keys. */
function keysBox(keys: Float64Array): { x0: number; z0: number; x1: number; z1: number } {
  const L = session.lattice
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const k of keys) {
    const x = L.x(keyGX(k)), z = L.z(keyGZ(k))
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  return { x0, z0, x1, z1 }
}

/**
 * The walking overlay on the edited regions near the camera (and, with the Walkable tool, every region within 300 m
 * of it, so the closed ground shows before you paint); returns the tiles the edits close there.
 */
function refreshWalk(regions?: readonly number[]): number {
  const edited = new Set([...session.heights.touchedRegions(), ...session.walk.touchedRegions()])
  const near = new Set<number>()
  for (const r of world.manifest.regions) {
    const d = Math.hypot(r.origin[0]! + 96 - cam.target.x, r.origin[2]! - 96 - cam.target.z)
    if ((edited.has(r.id) && d < 700) || (tool === 'walk' && d < 300)) near.add(r.id)
  }
  if (tool === 'walk') walkAround = session.regionAt(cam.target.x, cam.target.z)
  walk.keep(near)
  const { closedByEdit } = walk.update(regions ? regions.filter(r => near.has(r)) : near)
  return closedByEdit
}

/** While a Walkable stroke runs: the overlay follows the painted regions (at most every 100 ms). */
function walkLiveUpdate(force = false): void {
  if (!force && performance.now() - walkLive < 100) return
  const dirty = session.walk.takeDirty()
  if (!dirty.length) return
  walkLive = performance.now()
  walk.update(dirty)
  gate.invalidate()
}

// ---- history -------------------------------------------------------------------------------------------------------------

function afterHistory(c: Change | null, verb: string): void {
  if (!c) return say(verb === 'Undid' ? 'Nothing to undo.' : 'Nothing to redo.')
  if (c.height) {
    link.afterHeights(c.height.regions, keysBox(c.height.keys))
    refreshWalk(c.height.regions)
  }
  if (c.walk) {
    session.walk.takeDirty()
    link.refreshNav(c.walk.regions)
    refreshWalk(c.walk.regions)
  }
  if (c.objects) {
    void objects.refresh()
    void link.syncObjects()
    objects.refreshDeleted()
  }
  renderChanges()
  say(`${verb}: ${c.label}.`)
}

function undo(): void {
  if (locked()) return say(locked()!, 'warn')
  if (tool === 'route' && town) return town.undo()
  if (painting) cancelStroke()
  afterHistory(session.undo(), 'Undid')
}

function redo(): void {
  if (locked()) return say(locked()!, 'warn')
  if (tool === 'route' && town) return town.redo()
  afterHistory(session.redo(), 'Redid')
}

function revertOne(id: number): void {
  if (locked()) return say(locked()!, 'warn')
  const c = session.history.changes.find(x => x.id === id)
  if (!c) return
  if (c.state === 'done') {
    const deps = session.history.dependants(id)
    if (deps.length && !confirm(`These later changes move the same objects:\n\n${deps.map(d => `• ${d.label}`).join('\n')}\n\nRevert "${c.label}" anyway? They stay, on top of the original position.`)) return
  }
  const r = session.revertOne(id)
  afterHistory(r, r?.state === 'reverted' ? 'Reverted' : 'Re-applied')
}

function revertRegion(id: number): void {
  if (locked()) return say(locked()!, 'warn')
  if (!confirm(`Revert region ${regionName(id)} to the original map? Its ground, paint, grass, walking and object changes go away (Undo brings them back).`)) return
  const c = session.revertRegion(id)
  if (!c) return say(`Region ${regionName(id)} has no changes.`)
  afterHistory(c, 'Done')
  link.afterHeights(c.regions, null)
  if (c.objects) void link.syncObjects()
}

function renderChanges(): void {
  const ol = $('changeList')
  const list = session.history.changes
  const shown = list.slice(-150).reverse()
  ol.innerHTML = ''
  ol.setAttribute('start', String(list.length))
  for (const c of shown) {
    const li = document.createElement('li')
    li.className = c.state
    const link2 = document.createElement('span')
    link2.className = 'rv'
    link2.textContent = c.state === 'done' ? 'revert' : c.state === 'undone' ? 'redo' : 're-apply'
    link2.title = c.state === 'done' ? 'Take back just this change (later changes stay)' : 'Put this change back'
    link2.onclick = () => revertOne(c.id)
    const lbl = document.createElement('span')
    lbl.className = 'lbl'
    lbl.textContent = c.label
    li.append(link2, lbl)
    if (c.view) {
      lbl.classList.add('look')
      lbl.title = 'Look at it (fly the camera back to where you made this change)'
      lbl.onclick = () => lookAt(c.view!)
      const star = document.createElement('span')
      star.className = `star${c.starred ? ' on' : ''}`
      star.textContent = c.starred ? '★' : '☆'
      star.title = c.starred ? 'Starred: Publish takes a before / after picture here. Click to unstar.' : 'Star this view: Publish takes a before / after picture here'
      star.onclick = () => {
        c.starred = !c.starred || undefined
        session.unsaved++
        renderChanges()
      }
      li.append(star)
    }
    ol.appendChild(li)
  }
  $('changesCount').textContent = list.length ? `${list.length} change${list.length === 1 ? '' : 's'}` : ''
  $<HTMLButtonElement>('undo').disabled = !session.history.canUndo
  $<HTMLButtonElement>('redo').disabled = !session.history.canRedo
  updateSaved()
  if (minimap) minimap.edited = new Set(session.touchedRegions())
}

function updateSaved(): void {
  const el = $('saved')
  if (!api.available) el.textContent = session.unsaved ? 'Not saved: the editor API is not running (start it with pnpm editor).' : 'Edits stay on this PC until you save.'
  else if (session.unsaved) el.textContent = `${session.unsaved} unsaved change${session.unsaved === 1 ? '' : 's'}`
  else el.textContent = lastSavedAt ? 'Saved. Not published yet.' : 'No changes yet.'
}

async function save(quiet = false): Promise<boolean> {
  if (locked()) {
    say(locked()!, 'warn')
    return false
  }
  if (painting) endStroke()
  const t0 = performance.now()
  try {
    // WE-T: the town's routes and props (content/town/) first; a red path or a refusal stops the save with its reason
    const townSaved = town && api.available ? await town.save() : null
    const payload = await session.buildSave()
    const res = await api.save(payload)
    if (!res) {
      if (!quiet) say('Can\'t save: this page was opened without the editor API. Start the editor with "pnpm editor" (or the desktop shortcut); your changes stay here until then.', 'error')
      updateSaved()
      return false
    }
    session.markSaved(payload)
    lastSavedAt = Date.now()
    updateSaved()
    const files = payload.layers.filter(l => l.pixels).length
    const pf = payload.files['placements.json']
    const objs = pf.move.length + pf.drop.length + pf.add.length
    const count = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`
    if (!quiet) say(`Saved ${count(files, 'ground layer')} and ${count(objs, 'object edit')}${townSaved ? `, and the ${townSaved}` : ''} in ${Math.round(performance.now() - t0)} ms. Not published yet.`)
    return true
  } catch (err) {
    if ((err as { status?: number }).status === 409) {
      // DL-1: another tab (a duplicate of this one) holds the writer lease now
      readOnly = true
      api.readOnly = true
      showBanner('Another World Editor tab took over: this one only looks now. Reload it to edit here.')
    }
    say(`Save failed: ${(err as Error).message} Your changes are still here; try again.`, 'error')
    return false
  }
}

/** Saves only when something is unsaved (Publish and Test in game save first). */
async function saveIfNeeded(): Promise<boolean> {
  if (painting) endStroke()
  return session.unsaved || town?.unsaved ? save(true) : true
}

// ---- publish and test in game ----------------------------------------------------------------------------------------

/** The camera now, as a change records it (position xyz, target xyz). */
const cameraView = () => [cam.position.x, cam.position.y, cam.position.z, cam.target.x, cam.target.y, cam.target.z]

/** Flies back to a recorded view (a change's "look at it", the report's "Look"). */
function lookAt(v: readonly number[]): void {
  cam.setPosition(new Vector3(v[0], v[1], v[2]))
  cam.setTarget(new Vector3(v[3], v[4], v[5]))
  world.setFocus?.(v[3]!, v[5]!)
  gate.invalidate(30)
}

function hasChanges(): boolean {
  if (session.touchedRegions().length) return true
  say('Nothing to publish: you have not changed the map yet.', 'warn')
  return false
}

/** The views of the publish on screen (the API's list: the panel's "Look" links when there are no pictures). */
let lastViews: SheetView[] = []

function showRun(run: PublishRunView): void {
  panel.setViews(lastViews)
  panel.show(reportModel(run, session.history.changes, names), run)
  $('publish').classList.toggle('on', run.state === 'running' || run.state === 'ready')
}

function startPublish(): void {
  if (locked()) return say(locked()!, 'warn')
  if (!api.available) return say('Publish needs the editor API: start the editor with the desktop shortcut (or "pnpm editor"). Your changes stay in this tab until then.', 'error')
  void publish.start()
}

function startTest(): void {
  if (locked()) return say(locked()!, 'warn')
  if (!api.available) return say('Test in game needs the editor API: start the editor with the desktop shortcut (or "pnpm editor").', 'error')
  if (tester.active) {
    if (tester.state.url) return say('The test game is already running. Close its tab (or press Stop) to stop it.')
    return say('The test game is still starting…')
  }
  if (!session.touchedRegions().length) return say('Nothing to test yet: the game already shows the original map. Change something first.', 'warn')
  // the game's tab opens inside this click (no popup blocker stops it) and turns into the game when it is ready; it
  // plays the publish waiting for Keep, or a new one made now
  void tester.start(async () => {
    if (publish.ready) {
      if (session.unsaved) say('Test in game plays the publish that waits for Keep: your newest changes are not in it (Go back and publish again to add them).', 'warn')
      return true
    }
    const r = await publish.start()
    return r?.state === 'ready' || r?.state === 'stopped'
  })
}

// ---- before / after pictures (the API lists the views; the page renders them) ---------------------------------------

const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()))

/** Draws until streaming, uploads and object re-batches are done (at most 10 s), then two more frames. */
async function settle(): Promise<void> {
  const t0 = performance.now()
  for (let i = 0; performance.now() - t0 < 10_000; i++) {
    gate.invalidate(3)
    await frame()
    if (i > 6 && !link.pending && !world.stream?.busy && !objects.dragging && !grassBusy()) break
  }
  gate.invalidate(3)
  await frame()
  await frame()
}

/** The next drawn frame (captured at the end of that frame, as Babylon's screenshot does). */
let captureNext: ((canvas: HTMLCanvasElement) => void) | null = null
function capture(): Promise<{ png: string; url: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captureNext = null
      reject(new Error('no frame was drawn'))
    }, 8000)
    captureNext = canvas => {
      clearTimeout(timer)
      // 960 px wide: the sheet shows two side by side; the API keeps the PNG next to its report (≈ 1.5 MB each)
      const w = Math.min(960, canvas.width)
      const h = Math.round((canvas.height * w) / canvas.width)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(canvas, 0, 0, w, h)
      const url = c.toDataURL('image/png')
      resolve({ png: url.slice(url.indexOf(',') + 1), url })
    }
    gate.invalidate(2)
  })
}

/** Shows the original map (every edit taken out, nothing recorded, nothing saved) or puts the edits back. */
async function showOriginal(on: boolean): Promise<void> {
  if (on === !!hidden) return
  const regions = new Set<number>()
  if (on) {
    hidden = session.hideEdits()
    for (const p of hidden) for (const id of [...(p.height?.regions ?? []), ...(p.walk?.regions ?? [])]) regions.add(id)
  } else {
    for (const p of hidden!) for (const id of [...(p.height?.regions ?? []), ...(p.walk?.regions ?? [])]) regions.add(id)
    session.restoreEdits(hidden!)
    hidden = null
  }
  if (regions.size) link.afterHeights([...regions], null)
  refreshWalk()
  objects.refreshDeleted()
  $('compare').classList.toggle('on', !!hidden)
  gate.invalidate(10)
  await Promise.all([objects.refresh(), link.syncObjects()])
  gate.invalidate(4)
}

async function takeShots(views: readonly SheetView[], progress: (done: number, total: number) => void): Promise<Array<TakenShot & { beforePng: string; afterPng: string }>> {
  const out: Array<TakenShot & { beforePng: string; afterPng: string }> = []
  const list = views.filter(v => Array.isArray(v.view) && v.view.length === 6 && v.view.every(Number.isFinite)).slice(0, 8)
  lastViews = list
  if (!list.length) return out
  const keep = cameraView()
  if (painting) endStroke()
  await objects.deselect()
  const cover = $('shots')
  cover.classList.remove('hidden')
  // the pictures show the map as players see it: no walking tiles, brush ring or walker
  walk.setEnabled(false)
  ring.show(null, 0, 0)
  walker?.node.setEnabled(false)
  try {
    const after: Array<{ png: string; url: string }> = []
    for (const [i, v] of list.entries()) {
      lookAt(v.view)
      await settle()
      after.push(await capture())
      progress(i + 1, list.length * 2)
    }
    await showOriginal(true)
    for (const [i, v] of list.entries()) {
      lookAt(v.view)
      await settle()
      const before = await capture()
      out.push({ view: v.id, label: v.label, before: before.url, after: after[i]!.url, beforePng: before.png, afterPng: after[i]!.png })
      progress(list.length + i + 1, list.length * 2)
    }
  } finally {
    await showOriginal(false)
    walk.setEnabled($<HTMLInputElement>('walkOverlay').checked)
    refreshWalk()
    walker?.node.setEnabled(true)
    lookAt(keep)
    showRing()
    cover.classList.add('hidden')
  }
  return out
}

// ---- deploy (WE-A's hand-off: the user's click is the OK, D36) --------------------------------------------------------

async function refreshDeploy(): Promise<void> {
  const b = $<HTMLButtonElement>('deploy')
  try {
    const d = await backend.deploy()
    b.disabled = !d.ok && d.run?.phase !== 'running'
    b.title = d.sentence
  } catch {
    b.disabled = true
  }
}

async function startDeploy(): Promise<void> {
  if (locked()) return say(locked()!, 'warn')
  let d
  try {
    d = await backend.deploy()
  } catch (err) {
    return say(`Deploy can't run: ${(err as Error).message}`, 'error')
  }
  if (d.run?.phase === 'running') return say('A deploy is running: wait for it to finish.')
  if (!d.ok) return say(d.sentence, 'warn')
  const more = d.changes.length > 12 ? `\n• … and ${d.changes.length - 12} more` : ''
  const list = d.changes.length ? `\n\nWhat changes for the friends:\n${d.changes.slice(0, 12).map(c => `• ${c}`).join('\n')}${more}` : ''
  if (!confirm(`${d.sentence}${list}`)) return say('Not deployed. The map changes stay on this PC.')
  say('Deploying the map to the friends\' server… (about a minute)')
  try {
    d = await backend.deployRun()
    while (d.run?.phase === 'running') {
      await new Promise(r => setTimeout(r, 2000))
      d = await backend.deploy()
    }
    if (d.run?.phase === 'done') say('Deployed: the friends\' server has the new map. Players must reload the page.')
    else say(`The deploy did not finish: ${d.run?.log.at(-1) ?? d.sentence}`, 'error')
  } catch (err) {
    say(`The deploy did not start: ${(err as Error).message}`, 'error')
  }
  void refreshDeploy()
}

/** A check's "Show": fly to the object and select it, so G (snap), Move or Delete is one key away. */
async function showObject(ref: string): Promise<void> {
  const s = session.objects.current(ref)
  if (!s) return say('That object is not on the map any more (deleted or moved by a later change).', 'warn')
  setTool('move')
  flyTo(s.position[0], s.position[2])
  await objects.select([ref])
  renderSelection()
  say(`Selected ${objects.info()?.name ?? 'it'}: G puts it on the ground, W moves it, Del deletes it. Publish… brings the report back.`)
}

/** The API's own report page in a new tab (opened inside the click). */
async function fullReport(n: number): Promise<void> {
  const win = window.open('', '_blank')
  try {
    const html = await backend.page(n)
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    if (win) win.location.href = url
    else say('The browser blocked the report\'s tab: allow pop-ups for the editor.', 'warn')
  } catch (err) {
    win?.close()
    say(`The full report is not there: ${(err as Error).message}`, 'warn')
  }
}

function renderTestChip(v: TestInGameView): void {
  const el = $('testChip')
  const on = v.state !== 'idle' && v.state !== 'stopped'
  el.classList.toggle('hidden', !on)
  $('testGame').classList.toggle('on', on && v.state !== 'failed')
  if (!on) return
  const words: Record<TestInGameView['state'], string> = {
    idle: '', stopped: '', building: 'Building the test map…', starting: 'Starting the test server…', ready: 'Test game running', stopping: 'Stopping…', failed: 'Test in game failed',
  }
  const link = v.state === 'ready' && v.url ? ` <a href="${escapeHtml(v.url)}" target="sro-test-in-game" rel="noopener">open</a>` : ''
  const stop = v.state === 'stopping' ? '' : ` <button id="testStop" title="Stop the private test server">${v.state === 'failed' ? 'Dismiss' : 'Stop'}</button>`
  el.className = `chip${v.state === 'failed' ? ' bad' : ''}`
  el.title = v.message ?? ''
  el.innerHTML = `${escapeHtml(words[v.state])}${link}${stop}`
  const b = document.getElementById('testStop')
  if (b) b.onclick = () => void tester.stop()
}

/** The names of regions in the report: the manifest's places within 600 m. */
function regionNames(): RegionNames {
  const m = world.manifest as typeof world.manifest & { places?: Array<{ name: string; x: number; z: number }> }
  const centres = new Map(m.regions.map(r => [r.id, { x: r.origin[0]! + 96, z: r.origin[2]! - 96 }]))
  return new RegionNames(m.places ?? [], id => centres.get(id) ?? null)
}

// ---- paint palette and place list ------------------------------------------------------------------------------------

function buildPalette(): void {
  const list = $('paletteList')
  const text = $<HTMLInputElement>('paletteSearch').value.trim().toLowerCase()
  list.innerHTML = ''
  let last = ''
  let grid: HTMLDivElement | null = null
  for (const e of palette) {
    if (text && !e.name.toLowerCase().includes(text) && !e.title.toLowerCase().includes(text) && !e.label.toLowerCase().includes(text)) continue
    if (e.label !== last) {
      last = e.label
      const h = document.createElement('h4')
      h.textContent = e.label
      grid = document.createElement('div')
      grid.className = 'sw'
      list.append(h, grid)
    }
    const d = document.createElement('div')
    d.className = `${paintTile?.tile === e.tile ? 'on' : ''}${e.remastered ? ' up' : ''}`
    d.style.backgroundImage = `url("${e.swatch}")`
    d.title = `${e.title}${e.note ? `, ${e.note}` : ''}${e.remastered ? ' · upscaled' : ''} (${e.name})`
    d.onclick = () => pickTile(e)
    grid!.appendChild(d)
  }
  $('paletteCount').textContent = `${palette.length} grounds`
}

function pickTile(e: PaletteEntry): void {
  paintTile = e
  void link.acquireTile(e.tile)
  $('paintChip').style.backgroundImage = `url("${e.swatch}")`
  $('paintName').textContent = e.title
  $('paintName').title = e.name
  $('paintNote').textContent = `${e.label}${e.note ? `, ${e.note}` : ''}. Shift + drag brings back the original ground.`
  buildPalette()
  if (tool !== 'paint') setTool('paint')
  else say(`Paint: drag to paint ${e.title}.`)
}

function buildPlaceList(): void {
  const tabs = $('placeTabs')
  tabs.innerHTML = ''
  for (const t of ['All', ...LIBRARY_TABS] as const) {
    const s = document.createElement('span')
    s.textContent = t
    s.className = t === placeTab ? 'on' : ''
    s.onclick = () => {
      placeTab = t
      buildPlaceList()
    }
    tabs.appendChild(s)
  }
  const items = filterLibrary(library.items(), placeTab, $<HTMLInputElement>('placeSearch').value)
  const list = $('placeList')
  list.innerHTML = ''
  thumbs?.cancelAll()
  for (const it of items.slice(0, 400)) {
    const d = document.createElement('div')
    d.className = it.source === placeSource && it.placeable ? 'on' : ''
    if (!renderLibraryRow(d, it, thumbs)) {
      d.onclick = () => say(`${it.name} can't be placed yet: ${it.note ?? 'not in this export'}.`, 'warn')
      list.appendChild(d)
      continue
    }
    d.onclick = () => {
      placeSource = it.source
      buildPlaceList()
      if (tool !== 'place') setTool('place')
      void objects.beginPlace(it.source)
    }
    list.appendChild(d)
  }
  $('placeCount').textContent = `${items.length} models`
}

// ---- selection panel -------------------------------------------------------------------------------------------------

function renderSelection(): void {
  const info = objects.info()
  const el = $('selInfo')
  if (!info) {
    el.className = 'muted'
    el.textContent = 'Nothing selected. Click a rock, tree or prop.'
    return
  }
  el.className = ''
  const groundCls = info.ground === 'on the ground' ? 'var(--ok)' : 'var(--warn)'
  el.innerHTML = `<div class="row"><b>${escapeHtml(info.name)}</b><span class="muted">${info.isAdd ? 'new' : info.edited ? 'edited' : 'original'}</span></div>
    <div class="row"><span>Region</span><span>${info.region}</span></div>
    <div class="row"><span>Position</span><span>${info.position.map(v => v.toFixed(1)).join(', ')}</span></div>
    <div class="row"><span>Facing</span><span>${Math.round(info.facingDeg)}°</span></div>
    <div class="row"><span>Size</span><span>${Math.round(info.scale * 100)} %</span></div>
    <div class="row"><span>Ground</span><span style="color:${groundCls}">${info.ground}</span></div>
    <div class="row"><span>Blocks walking</span><span>${info.blocksWalking ? 'yes: its footprint moves with it' : 'no'}</span></div>`
  for (const [id, m] of [['modeMove', 'move'], ['modeTurn', 'turn'], ['modeScale', 'scale']] as const) $(id).classList.toggle('on', objects.mode === m)
  $('selMode').textContent = objects.mode === 'move' ? 'moving' : objects.mode === 'turn' ? 'turning' : 'resizing'
}

function setGizmo(m: GizmoMode): void {
  objects.setMode(m)
  renderSelection()
  gate.invalidate()
}

// ---- the budget line and the minimap ---------------------------------------------------------------------------------

function renderBudget(): void {
  const rid = session.regionAt(cam.target.x, cam.target.z)
  const list = link.lowered().regions.get(rid) ?? link.originalList(rid)
  const b = world.manifest.regions.some(r => r.id === rid) ? regionBudget(rid, list, link.trianglesOf) : null
  const el = $('budget')
  el.textContent = budgetText(b, { draws, preset: PRESET })
  el.className = b && b.level !== 'ok' ? b.level : ''
  if (b?.notes.length) el.title = b.notes.join('\n')
  if (link.objectProblems.length) el.title = `${el.title ?? ''}\n${link.objectProblems.join('\n')}`
}

function drawMinimap(): void {
  if (!minimap || $('minimap').classList.contains('hidden')) return
  const f = cam.getForwardRay(1).direction
  minimap.draw({ x: cam.target.x, z: cam.target.z, fx: f.x, fz: f.z })
}

function flyTo(x: number, z: number): void {
  cam.target.set(x, (ground(x, z) ?? cam.target.y) + 1.5, z)
  world.setFocus?.(x, z)
  gate.invalidate(30)
}

// ---- help ------------------------------------------------------------------------------------------------------------

function toggleHelp(): void {
  const el = $('help')
  if (el.classList.toggle('hidden')) return
  const rows = TOOLS.filter((t): t is ToolDef => !!t).map(t => `<tr><td><kbd>${t.key}</kbd></td><td><b>${t.name}</b>${t.later ? ` <span class="muted">(${t.later})</span>` : ''}</td></tr>`).join('')
  el.innerHTML = `<h2>World Editor: the keys</h2>
    <p>Everything you change is kept as a layer over the original map: nothing is destroyed. <b>Save</b> keeps it on this PC; players see nothing until you publish.</p>
    <table>${rows}</table>
    <p>${KEYS.common}</p>
    <p><b>Changes</b>: every stroke, move or delete is one row. "revert" takes back just that one; later changes stay. Right-click a region on the map to revert all of it.</p>
    <p><b>Red tiles</b>: ground players can't walk on. Bright red: your edit made it steeper than 35° (or you closed it). Smooth the sides to open it again, or paint it open with <b>Walkable</b> (Y): green tiles are ground you opened. Ground outside the playable area, in the sea or under a building or object can't be opened.</p>
    <p><b>Changes</b>: click a row to fly back to where you made it; ☆ stars that view, so Publish takes a before / after picture there. <b>Original</b> shows the map without your changes, to compare.</p>
    <p><b>Publish…</b> checks your changes (walking, reachability, objects on moved ground, budgets), re-builds the regions you touched and shows a report: <b>Keep</b> makes it the map on this PC, <b>Go back</b> throws the build away (your edits stay). <b>Test in game</b> opens the real game on a private test server with that build; close its tab to stop it. Players see nothing until a <b>Deploy</b>.</p>
    <p class="muted">Click anywhere in this box or press F1 to close it.</p>`
  el.onclick = () => el.classList.add('hidden')
}

// ---- walk here ---------------------------------------------------------------------------------------------------------

function toggleWalk(): void {
  walkMode = !walkMode
  $('walkBtn').classList.toggle('on', walkMode)
  if (!walkMode) {
    walker?.node.dispose(false, true)
    walker?.stop()
    walker = null
    say('Stopped walking.')
  } else say('Walk here: click the ground to put the adventurer there, then click to walk him (the walking as Publish will build it). Esc stops.')
  gate.invalidate()
}

async function walkClick(at: Vector3): Promise<void> {
  if (walker) {
    const r = walker.moveTo(at)
    if (r.blocked) say('Blocked: players can\'t walk there (a closed tile, a wall or an object\'s footprint).', 'warn')
    gate.invalidate()
    return
  }
  if (walkerLoading) return
  const pos = world.locate(at.x, at.z, at.y)
  if (!pos) return say('Nobody can stand there. Click open ground.', 'warn')
  walkerLoading = true
  try {
    const p = new Player(scene, world.nav, pos, 1)
    await p.load(new Assets(BASE), world.materials, 'char/china/chinaman_adventurer.glb', 'char/china/chinaman_adventurer.json')
    for (const m of p.node.getChildMeshes()) world.render.addCharacter(m)
    if (!walkMode) {
      p.node.dispose(false, true)
      return
    }
    walker = p
    say('Click the ground to walk there. Esc stops walking.')
  } catch (err) {
    say(`The adventurer could not load: ${(err as Error).message}`, 'error')
  } finally {
    walkerLoading = false
    gate.invalidate()
  }
}

// ---- the loop --------------------------------------------------------------------------------------------------------

let lastBudget = 0
function tick(engine: AbstractEngine): void {
  // fly while the right button is held
  const dt = Math.min(0.1, engine.getDeltaTime() / 1000)
  let flying = false
  if (rmbHeld && held.size) {
    const speed = Math.max(20, cam.radius * 0.8) * (held.has('shift') ? 3 : 1) * dt
    const f = cam.getForwardRay(1).direction
    const fwd = new Vector3(f.x, 0, f.z).normalize()
    const right = new Vector3(-fwd.z, 0, fwd.x)
    const mv = new Vector3()
    if (held.has('w')) mv.addInPlace(fwd)
    if (held.has('s')) mv.subtractInPlace(fwd)
    if (held.has('d')) mv.addInPlace(right)
    if (held.has('a')) mv.subtractInPlace(right)
    if (held.has('e')) mv.y += 1
    if (held.has('q')) mv.y -= 1
    if (mv.lengthSquared() > 0) {
      cam.target.addInPlace(mv.scale(speed))
      flying = true
    }
  }
  if (painting && performance.now() - lastStamp >= 33) stampNow()
  const walking = !!walker && (walker.walker.moving || walker.speed > 0.01)
  const busy = flying || walking || !!painting || objects.dragging || link.pending || !!world.stream?.busy || grassBusy()
  if (!gate.tick(busy)) return
  walker?.update(dt)
  link.flush()
  world.update(cam, { x: cam.target.x, z: cam.target.z })
  const d0 = (engine as unknown as { _drawCalls?: { current: number } })._drawCalls?.current ?? 0
  scene.render()
  if (captureNext) {
    const cb = captureNext
    captureNext = null
    engine.onEndFrameObservable.addOnce(() => cb(engine.getRenderingCanvas()!))
  }
  const d1 = (engine as unknown as { _drawCalls?: { current: number } })._drawCalls?.current ?? 0
  if (d1 >= d0) draws = d1 - d0
  if (viewWatch.changed(cam.getViewMatrix().m)) gate.invalidate(2)
  const now = performance.now()
  if (now - lastBudget > 400) {
    lastBudget = now
    renderBudget()
    drawMinimap()
    if (objects.selection.length) renderSelection()
    // the Walkable tool: the walking tiles follow the camera from region to region
    if (tool === 'walk' && !painting && session.regionAt(cam.target.x, cam.target.z) !== walkAround) {
      refreshWalk()
      gate.invalidate()
    }
  }
}

function grassBusy(): boolean {
  const f = grassFieldOf(world.scatter) as unknown as { stats?: { pending?: number } } | null
  return !!f?.stats?.pending
}

// ---- input -------------------------------------------------------------------------------------------------------------

function wireInput(canvas: HTMLCanvasElement): void {
  scene.onPointerObservable.add(pi => {
    const ev = pi.event as PointerEvent
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), cam)
    // WE-T: the Routes tool takes the left button (the camera keeps the right drag)
    if (tool === 'route' && town && !walkMode) {
      const kind = pi.type === PointerEventTypes.POINTERDOWN ? 'down' : pi.type === PointerEventTypes.POINTERUP ? 'up' : pi.type === PointerEventTypes.POINTERMOVE ? 'move' : null
      if (kind && town.pointer(pi, ray, kind)) return gate.invalidate(2)
    }
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      gate.invalidate(4)
      if (ev.button === 2) {
        rmbHeld = true
        return
      }
      if (ev.button !== 0) return
      if (walkMode) {
        const hit = groundHit(ray)
        if (hit) void walkClick(hit)
        return
      }
      if (objects.placing) {
        // the clicked ground point, never the ghost's last mouse-move position (V-12)
        const at = groundHit(ray)
        if (at) lastHit = at
        void objects.landGhost(ev.shiftKey, at)
        return
      }
      if (tool === 'move') {
        if (objects.gizmoHovered) return
        const near = groundHit(ray) ?? cam.target
        const ref = objects.pick(ray, { x: near.x, z: near.z })
        // WE-T (§F4): a town dressing prop is edited by its row, with the Routes tool
        const row = ref ? town?.rowOfRef(ref) : null
        if (row) {
          setTool('route')
          town!.select({ kind: 'row', id: row })
          return say(`${row} is a town prop: the Routes tool (T) moves it by its row in the town's dressing. Drag it to move it.`)
        }
        if (ref && isDressingRef(ref)) return say('That is a town prop: the Routes tool (T) moves it by its row once the town file has loaded.', 'warn')
        if (ref && objects.isDeleted(ref)) {
          void objects.restore(ref).then(() => renderChanges())
          return
        }
        if (ref) void objects.select([ref], ev.shiftKey ? 'add' : ev.ctrlKey ? 'remove' : 'set').then(renderSelection)
        else rectStart = { x: scene.pointerX, y: scene.pointerY }
        return
      }
      lastHit = groundHit(ray)
      if (ev.altKey && lastHit) {
        if (tool === 'flatten') {
          $<HTMLInputElement>('flattenTo').value = lastHit.y.toFixed(2)
          say(`Flatten height set to ${lastHit.y.toFixed(2)} m. Drag to flatten to it; clear the box to use where you start.`)
          return
        }
        if (tool === 'paint') {
          const L = session.lattice
          const w = session.paint.wordAt(Math.round(L.toGX(lastHit.x)), Math.round(L.toGZ(lastHit.z)))
          const e = palette.find(p => p.tile === (w & 0x3ff))
          if (e) pickTile(e)
          return
        }
      }
      if (BRUSH_TOOLS.includes(tool)) beginStroke(ev.shiftKey)
    } else if (pi.type === PointerEventTypes.POINTERUP) {
      if (ev.button === 2) rmbHeld = false
      if (ev.button !== 0) return
      if (painting) endStroke()
      if (rectStart) {
        const r = rectStart
        rectStart = null
        $('rect').classList.add('hidden')
        const dx = Math.abs(scene.pointerX - r.x), dy = Math.abs(scene.pointerY - r.y)
        if (dx < 4 && dy < 4) {
          if (!ev.shiftKey && !ev.ctrlKey && objects.selection.length) void objects.deselect().then(renderSelection)
          return
        }
        const refs = objects.pickRect(r.x, r.y, scene.pointerX, scene.pointerY, cam, { x: cam.target.x, z: cam.target.z })
        void objects.select(refs, ev.shiftKey ? 'add' : ev.ctrlKey ? 'remove' : 'set').then(renderSelection)
      }
    } else if (pi.type === PointerEventTypes.POINTERMOVE) {
      if (rectStart) {
        const el = $('rect')
        const r = canvas.getBoundingClientRect()
        el.classList.remove('hidden')
        el.style.left = `${r.left + Math.min(rectStart.x, scene.pointerX)}px`
        el.style.top = `${r.top + Math.min(rectStart.y, scene.pointerY)}px`
        el.style.width = `${Math.abs(scene.pointerX - rectStart.x)}px`
        el.style.height = `${Math.abs(scene.pointerY - rectStart.y)}px`
        return
      }
      if (BRUSH_TOOLS.includes(tool) || objects.placing) {
        lastHit = groundHit(ray)
        if (objects.placing && lastHit) objects.moveGhost(lastHit.x, lastHit.z)
        showRing()
      }
      if (rmbHeld) gate.invalidate(2)
    }
  })
  // the wheel turns a ghost being placed (the camera never sees that wheel)
  window.addEventListener('wheel', e => {
    gate.invalidate(20)
    if (!objects?.placing || e.target !== canvas) return
    e.preventDefault()
    e.stopPropagation()
    objects.turnGhost(Math.sign(e.deltaY) * (Math.PI / 12))
  }, { capture: true, passive: false })
  canvas.addEventListener('contextmenu', e => e.preventDefault())
  canvas.addEventListener('pointerleave', () => {
    rmbHeld = false
    held.clear()
  })

  window.addEventListener('keydown', e => {
    const tag = (e.target as HTMLElement).tagName
    ctrlHeld = e.ctrlKey
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    const k = e.key.toLowerCase()
    gate.invalidate(4)
    if (rmbHeld && ['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k)) {
      held.add(k)
      e.preventDefault()
      return
    }
    if (e.key === 'F1') {
      e.preventDefault()
      return toggleHelp()
    }
    if (tool === 'route' && town?.key(e)) return
    if (e.ctrlKey && k === 'z') return e.preventDefault(), undo()
    if (e.ctrlKey && k === 'y') return e.preventDefault(), redo()
    if (e.ctrlKey && k === 's') return e.preventDefault(), void save()
    if (e.ctrlKey && k === 'c') return e.preventDefault(), objects.copy()
    if (e.ctrlKey && k === 'v') {
      e.preventDefault()
      if (tool !== 'move' && tool !== 'place') setTool('move')
      void objects.beginPaste()
      return
    }
    if (e.ctrlKey || e.altKey) return
    if (k === 'escape') {
      if (panel?.visible) return panel.hide()
      if (painting) return cancelStroke()
      if (walkMode) return toggleWalk()
      if (objects.placing) {
        objects.cancelGhost()
        return say('Stopped placing.')
      }
      if (!$('help').classList.contains('hidden')) return $('help').classList.add('hidden')
      void objects.deselect().then(renderSelection)
      return
    }
    if (tool === 'move' && objects.selection.length) {
      if (k === 'w') return setGizmo('move')
      if (k === 'e') return setGizmo('turn')
      if (k === 'r') return setGizmo('scale')
      if (k === 'g') return void objects.snapToGround().then(renderSelection)
      if (k === 'delete' || k === 'backspace') return void objects.deleteSelected().then(() => (renderSelection(), renderChanges()))
    }
    if (k === 'm') {
      const on = $('minimap').classList.toggle('hidden')
      $<HTMLInputElement>('minimapOn').checked = !on
      return
    }
    const sz = $<HTMLInputElement>('size'), st = $<HTMLInputElement>('str')
    if (k === '[') return (sz.value = String(size() - 2)), syncSliders()
    if (k === ']') return (sz.value = String(size() + 2)), syncSliders()
    if (k === '-') return (st.value = String(Math.round(strength() * 100) - 5)), syncSliders()
    if (k === '=') return (st.value = String(Math.round(strength() * 100) + 5)), syncSliders()
    const t = TOOLS.find(x => x && x.key.toLowerCase() === k)
    if (t) setTool(t.id)
  })
  window.addEventListener('keyup', e => {
    ctrlHeld = e.ctrlKey
    held.delete(e.key.toLowerCase())
    if (e.key === 'Shift') held.delete('shift')
  })
  window.addEventListener('blur', () => {
    held.clear()
    rmbHeld = false
    ctrlHeld = false
  })
}

// ---- start -------------------------------------------------------------------------------------------------------------

/** The tokenless `?at=x,z` link (the game's /editmap): sends the open editor tab there, or says how to start it. */
function flyLinkPage(): void {
  $('loading').innerHTML = 'Looking for the open World Editor…'
  const ch = new BroadcastChannel(FLY_CHANNEL)
  let acked = false
  ch.onmessage = e => {
    if ((e.data as FlyMessage)?.type === 'ack') {
      acked = true
      $('loading').innerHTML = `The World Editor is flying to ${AT[0]!.toFixed(0)}, ${AT[1]!.toFixed(0)}. You can close this tab.`
    }
  }
  ch.postMessage({ type: 'fly', x: AT[0], z: AT[1] } satisfies FlyMessage)
  setTimeout(() => {
    if (!acked) $('loading').innerHTML = 'The World Editor is not open. Start it from the desktop shortcut "Silkroad World Editor", then use /editmap again.'
  }, 1200)
}

function hasToken(): boolean {
  if (q.get('k')) return true
  try {
    return !!sessionStorage.getItem('sro-editor-token')
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  if (!hasToken() && HAS_AT) return flyLinkPage()
  buildTools()
  api = new EditorApi(WORLD)
  await api.open(reason => {
    readOnly = true
    showBanner(reason)
  })
  $('title').textContent = `World Editor · ${WORLD}`
  for (const id of ['size', 'str', 'soft']) $(id).addEventListener('input', syncSliders)
  $<HTMLSelectElement>('preset').value = PRESET
  const canvas = $<HTMLCanvasElement>('c')
  const { engine: eng, kind, gpu } = await createEngine(canvas, q.get('engine') !== 'webgl')
  guardGlsl(eng)
  eng.setHardwareScalingLevel(1)
  window.addEventListener('resize', () => {
    eng.resize()
    gate.invalidate()
  })
  scene = new Scene(eng)
  scene.useRightHandedSystem = true
  scene.skipPointerMovePicking = true
  scene.skipPointerDownPicking = true
  const focus = HAS_AT ? { x: AT[0]!, z: AT[1]! } : { x: 100, z: -112 }
  cam = new ArcRotateCamera('editorCam', -1.57, 1.0, 90, new Vector3(focus.x, 0, focus.z), scene)
  cam.minZ = 0.2
  cam.maxZ = 4000
  cam.fov = 0.87
  cam.lowerRadiusLimit = 3
  cam.upperRadiusLimit = 900
  cam.upperBetaLimit = 1.55
  cam.wheelDeltaPercentage = 0.02
  cam.panningSensibility = 40
  cam.attachControl(true)
  const pointers = cam.inputs.attached.pointers as ArcRotateCameraPointersInput | undefined
  if (pointers) pointers.buttons = [1, 2]
  cam.movement.input.setInteraction('pointer', { button: 2 }, 'rotate')
  cam.movement.input.setInteraction('pointer', { button: 1 }, 'pan')
  const t0 = Math.min(0.999, Math.max(0, Number(q.get('t') ?? 0.42) || 0.42))
  say(`${kind}: loading ${WORLD} (${PRESET}, the game's own renderer)…`)
  const quality: WorldQuality = PRESET
  // WE-T: the town files (the API's content/town/) come first, so the crowd walks the file being edited
  const townLoad = TownTool.fetch(api)
  world = await loadWorld(scene, {
    parts: { town: townPreview.factory() },
    baseUrl: BASE, world: WORLD, quality, render: PRESET === 'low' ? 'classic' : 'pbr', sky: PRESET === 'low' ? 'classic' : 'modern',
    weatherLevel: 'off', gpu, timeOfDay: t0, focus, waitForObjects: false, readyRadiusM: 260,
    onProgress: p => ($('loading').textContent = `Loading the map: ${p.stage} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`),
  })
  world.setTimeOfDay(t0)
  for (const w of world.warnings) console.warn('[world]', w)
  cam.target.y = (ground(focus.x, focus.z) ?? 0) + 1.5
  const m = world.manifest

  session = new EditSession({
    world: WORLD, originRegion: m.space.originRegion, regions: m.regions.map(r => r.id), placements: m.placements,
    host: { heights: id => world.regions.get(id)?.terrain.heights ?? null, words: id => world.regions.get(id)?.terrain.textures ?? null },
  })
  if (world.coast) session.heights.guard = new CoastGuard(world.coast)
  link = new WorldLink(world, session, () => gate.invalidate())
  link.install()
  objects = new ObjectsView({
    scene, world, session, link,
    ground,
    baseGround: (x, z) => session.heights.baseGround(x, z) ?? ground(x, z),
    holdHeight: () => ctrlHeld,
    canEdit: () => !locked(),
    lockedReason: locked,
    invalidate: () => gate.invalidate(),
    say,
    changed: () => {
      renderSelection()
      renderChanges()
      objects?.refreshDeleted()
    },
    trees: new TreeLook(scene, world),
  })
  shadows = new ShadowBaker({ world, session, invalidate: () => gate.invalidate() })
  town = new TownTool({
    scene, world, api, preview: townPreview, groundHit,
    camDistance: (x, y, z) => Vector3.Distance(cam.position, new Vector3(x, y, z)),
    say, invalidate: () => gate.invalidate(), canEdit: () => !locked(),
    syncObjects: regions => void link.syncObjects(regions),
    homeOf: p => link.homeOf(p),
  }, await townLoad)
  ring = new BrushRing(scene, ground)
  walk = new WalkOverlay(scene, link)
  // the library (WE-L): the new species placed as their carriers, every converted model, thumbnails rendered here
  library = buildLibrary({ manifest: m, treeLibrary: await fetchTreeLibrary(TREE_LIBRARY_URL), outBase: BASE })
  // labels and sentences say "Placed Maple", not the carrier's file name
  setDisplayNames(library.items().filter(i => i.kind === 'species' && i.placeable).map(i => [i.source, i.name] as const))
  if (library.problems.length) console.warn('[editor] content/trees/library.json:', library.problems)
  installLibraryCss()
  thumbs = new LibraryThumbs({
    scene, world: WORLD, manifest: m,
    models: () => world.stream?.models ?? null,
    spot: () => new Vector3(cam.target.x, (ground(cam.target.x, cam.target.z) ?? 0) + 400, cam.target.z),
    invalidate: () => gate.invalidate(),
    paused: () => gate.lockedByOther,
  })

  // the palette: the API's palette.json, else the repo's (jangan-fields), else the fallback groups
  let paletteFile: PaletteFile | null = null
  try {
    paletteFile = ((await api.palette()) as PaletteFile | null)
      ?? (WORLD === 'jangan-fields' ? await (await fetch(new URL('../../../../content/world-edits/jangan-fields/palette.json', import.meta.url))).json() as PaletteFile : null)
  } catch {
    paletteFile = null
  }
  if (paletteFile) {
    const problems = validatePalette(paletteFile, m.tiles)
    if (problems.length) console.warn('[editor] palette.json:', problems)
  }
  let pbr: PbrIndexLike | null = null
  try {
    const r = await fetch(`${BASE}pbr/index.json`)
    if (r.ok) pbr = await r.json() as PbrIndexLike
  } catch {
    pbr = null
  }
  palette = paletteEntries(m.tiles, paletteFile, pbr, { tileBase: WORLD_URL, pbrBase: `${BASE}pbr/` })
  tiling = tilingCodes(world.regions.regions.map(r => r.terrain.textures))
  buildPalette()
  buildPlaceList()

  // saved edits (and the journal) back from the editor API
  try {
    const status = await api.status()
    const saved = await api.load()
    if (saved) {
      const problems = session.load(saved)
      if (problems.length) say(`Loaded your saved edits with ${problems.length} problem(s): ${problems[0]}`, 'warn')
      // DL-4 (§3.1): the map was rebuilt under saved edits
      const moved = await session.changedBases()
      const changedObjs = session.objects.changedUnder()
      if (moved.length || changedObjs.length) {
        const parts = [
          moved.length ? `the ground under your edits changed in ${moved.map(regionName).join(', ')}` : '',
          changedObjs.length ? `${changedObjs.length} object(s) you moved or deleted changed in the map` : '',
        ].filter(Boolean)
        showBanner(`The map was rebuilt since your last Save: ${parts.join('; ')}. Look at those places before you publish.`)
      }
      // DL-5: an interrupted Save left files that do not match the change list
      if (api.mismatched.length && !readOnly) {
        const list = api.mismatched.slice(0, 6).join(', ') + (api.mismatched.length > 6 ? ` and ${api.mismatched.length - 6} more` : '')
        showBanner(`The last Save was interrupted: ${list} do not match the change list.`)
        if (confirm(`The last Save was interrupted, so these files do not match the change list: ${list}.

OK: keep the files as they are (the change list starts over from them).
Cancel: keep the change list; press Save to write your open state again.`)) {
          await api.request('POST', 'journal/reset', {})
          say('Kept the files as they are: the change list starts over from them.', 'warn')
        } else say('Press Save to write your open state again.', 'warn')
      }
      void link.syncObjects()
      link.refreshNav([...new Set([...session.heights.touchedRegions(), ...session.walk.touchedRegions()])])
      refreshWalk()
      if (session.touchedRegions().length) lastSavedAt = Date.now()
    }
    pollStatus(status)
  } catch (err) {
    say(`The editor API answered with an error: ${(err as Error).message}`, 'error')
  }

  if (m.stream?.worldMap) {
    minimap = new MinimapView($<HTMLCanvasElement>('minimap'), {
      map: m.stream.worldMap, playable: m.stream.playable ?? null, originRegion: m.space.originRegion, regions: new Set(m.regions.map(r => r.id)),
    }, WORLD_URL, { fly: flyTo, revertRegion })
  } else $('minimap').classList.add('hidden')

  // Publish…, Test in game and Deploy (publish.ts; the routes are the editor API's, WE-A)
  names = regionNames()
  session.viewOf = cameraView
  backend = new HttpPublishBackend((method, path, body, init) => api.request(method, path, body, init))
  panel = new PublishPanel($('publishPanel'), {
    keep: () => void publish.keep().then(() => refreshDeploy()),
    goBack: () => void publish.goBack(),
    undo: () => {
      if (confirm('Undo this publish? The map on this PC goes back to how it was before it (your edits stay in the editor).')) void publish.undo().then(() => refreshDeploy())
    },
    testInGame: startTest,
    look: v => lookAt(v.view),
    fullReport: n => void fullReport(n),
    show: ref => void showObject(ref),
  })
  publish = new PublishFlow(backend, { save: saveIfNeeded, hasChanges, show: showRun, say, takeShots, fallbackViews: () => sheetViews(session.history.changes) })
  tester = new TestInGame(backend, {
    openWindow: () => window.open('', 'sro-test-in-game') as GameWindow | null,
    say,
    onState: renderTestChip,
  })
  $('publish').onclick = () => {
    publish.poke()
    if (publish.run && !panel.visible && (publish.run.state === 'running' || publish.run.state === 'ready')) showRun(publish.run)
    else startPublish()
  }
  // a hidden tab's timers are slowed: ask the API as soon as the editor is seen again (V-12)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') publish.poke()
  })
  $('testGame').onclick = startTest
  $('deploy').onclick = () => void startDeploy()
  $('compare').onclick = () => {
    if (!hidden && !session.touchedRegions().length) return say('Nothing to compare yet: this is the original map.')
    if (painting) endStroke()
    void showOriginal(!hidden).then(() => say(hidden ? 'The original map, without your changes. Press Original again to see them and keep editing.' : 'Your changes are back.'))
  }
  window.addEventListener('pagehide', () => {
    if (tester.active) void tester.stop(true)
  })
  if (api.available) {
    void publish.resume()
    void refreshDeploy()
  }

  // top bar
  $('undo').onclick = undo
  $('redo').onclick = redo
  $('save').onclick = () => void save()
  $('helpBtn').onclick = toggleHelp
  $('walkBtn').onclick = toggleWalk
  $<HTMLInputElement>('time').oninput = () => {
    const t = Number($<HTMLInputElement>('time').value)
    world.setTimeOfDay(t)
    $('timeOut').textContent = formatTime(t)
    gate.invalidate(3)
  }
  $<HTMLInputElement>('time').value = String(t0)
  $('timeOut').textContent = formatTime(t0)
  $<HTMLInputElement>('animate').onchange = () => {
    gate.animate = $<HTMLInputElement>('animate').checked
    gate.invalidate()
  }
  $<HTMLInputElement>('walkOverlay').onchange = () => {
    walk.setEnabled($<HTMLInputElement>('walkOverlay').checked)
    refreshWalk()
    gate.invalidate()
  }
  $<HTMLInputElement>('minimapOn').onchange = () => $('minimap').classList.toggle('hidden', !$<HTMLInputElement>('minimapOn').checked)
  $<HTMLSelectElement>('preset').onchange = async () => {
    const p = $<HTMLSelectElement>('preset').value
    if (session.unsaved && !(await save(true)) && !confirm('Your changes are not saved (no editor API). Switching the look reloads the page and loses them. Switch anyway?')) {
      $<HTMLSelectElement>('preset').value = PRESET
      return
    }
    const u = new URL(location.href)
    u.searchParams.set('preset', p)
    u.searchParams.set('at', `${cam.target.x.toFixed(1)},${cam.target.z.toFixed(1)}`)
    location.href = u.toString()
  }
  $('paletteSearch').oninput = buildPalette
  $('placeSearch').oninput = buildPlaceList
  $<HTMLInputElement>('scatter').onchange = () => (objects.scatter = $<HTMLInputElement>('scatter').checked)
  for (const b of $('grassModes').querySelectorAll<HTMLButtonElement>('button')) {
    b.onclick = () => {
      grassMode = b.dataset.mode as GrassMode
      for (const o of $('grassModes').querySelectorAll('button')) o.classList.toggle('on', o === b)
      say(`Grass: ${b.title}.`)
    }
  }
  for (const b of $('walkModes').querySelectorAll<HTMLButtonElement>('button')) {
    b.onclick = () => {
      walkBrush = b.dataset.mode as WalkMode
      for (const o of $('walkModes').querySelectorAll('button')) o.classList.toggle('on', o === b)
      if (tool !== 'walk') setTool('walk')
      say(`Walkable: ${b.title}.`)
      showRing()
    }
  }
  // the Walkable brush's hard limits (outside the bounds, the sea, under buildings and objects), as Publish applies them
  session.walk.guard = id => link.walkRefusals(id)
  $('selSnap').onclick = () => void objects.snapToGround().then(renderSelection)
  $('selBack').onclick = () => void objects.putBack().then(renderSelection)
  $('selDelete').onclick = () => void objects.deleteSelected().then(() => (renderSelection(), renderChanges()))
  $<HTMLInputElement>('showDeleted').onchange = () => objects.setShowDeleted($<HTMLInputElement>('showDeleted').checked)
  $('modeMove').onclick = () => setGizmo('move')
  $('modeTurn').onclick = () => setGizmo('turn')
  $('modeScale').onclick = () => setGizmo('scale')

  // the game's /editmap link: fly here
  const fly = new BroadcastChannel(FLY_CHANNEL)
  fly.onmessage = e => {
    const msg = e.data as FlyMessage
    if (msg?.type !== 'fly' || !Number.isFinite(msg.x) || !Number.isFinite(msg.z)) return
    flyTo(msg.x!, msg.z!)
    fly.postMessage({ type: 'ack' } satisfies FlyMessage)
    say(`Flew to ${msg.x!.toFixed(0)}, ${msg.z!.toFixed(0)} (from the game).`)
  }

  window.addEventListener('beforeunload', e => {
    if (session.unsaved || town?.unsaved) e.preventDefault()
  })
  setInterval(() => {
    if (session.unsaved && api.available && !locked() && !publish.busy && Date.now() - lastSavedAt > 110_000) void save(true)
  }, 120_000)

  wireInput(canvas)
  setTool('raise')
  syncSliders()
  renderChanges()
  $('loading').classList.add('hidden')
  gate.invalidate(60)
  eng.runRenderLoop(() => tick(eng))
  ;(window as unknown as { ed: unknown }).ed = scriptApi()
  const extra = api.available ? '' : ' (no editor API: edits stay in this tab)'
  const ready = `Ready (${kind}, ${PRESET}). Raise: drag on the ground. Shift lowers. Right-drag to look around, Right + WASD to fly.${extra}`
  // DL-5: the API took over the lock a killed or crashed editor left: say so (the terminal said it too)
  if (api.notice) say(`${api.notice} ${ready}`, 'warn')
  else say(ready)
}

function showBanner(text: string | null): void {
  const el = $('banner')
  el.classList.toggle('hidden', !text)
  if (text) el.textContent = text
}

function pollStatus(first: Awaited<ReturnType<EditorApi['status']>>): void {
  const apply = (s: typeof first) => {
    const owner = s?.gpuLock ?? null
    gate.lockedByOther = !!owner
    if (!readOnly) showBanner(owner ? `The GPU is busy with "${owner}": the editor stops its moving previews until it is done.` : null)
  }
  apply(first)
  if (!api.available) return
  setInterval(() => {
    api.status().then(apply, () => {})
  }, 15_000)
}

function guardGlsl(engine: AbstractEngine): void {
  if (!(engine instanceof WebGPUEngine)) return
  type Prepare = (ctx: { shaderProcessingContext?: { shaderLanguage?: number } }, ...rest: unknown[]) => Promise<void>
  const e = engine as unknown as { _preparePipelineContextAsync: Prepare }
  const orig = e._preparePipelineContextAsync.bind(engine)
  e._preparePipelineContextAsync = (ctx, ...rest) => {
    if (ctx.shaderProcessingContext?.shaderLanguage === 0) {
      const key = String(rest[8] ?? '?').split('\n')[0]!.slice(0, 80)
      errors.push(`GLSL on WebGPU: ${key}`)
      console.error(`[editor] GLSL shader reached the WebGPU engine and was blocked: ${key}`)
      return new Promise<void>(() => {})
    }
    return orig(ctx, ...rest)
  }
}

/** `window.ed`: the scripted session the user check and the lab drive (the prototype's API, kept small). */
function scriptApi() {
  return {
    get world() { return world },
    get session() { return session },
    get objects() { return objects },
    get link() { return link },
    get town() { return town },
    get cam() { return cam },
    gate, stampStats, errors,
    setTool: (t: Tool) => setTool(t),
    flyTo,
    undo, redo, save,
    /** A stroke of n stamps from (x0, z0) to (x1, z1), one per frame (as a drag). */
    async stroke(t: Tool, x0: number, z0: number, x1: number, z1: number, n = 20, o: { size?: number; strength?: number; softness?: number; shift?: boolean } = {}) {
      if (o.size) $<HTMLInputElement>('size').value = String(o.size)
      if (o.strength) $<HTMLInputElement>('str').value = String(Math.round(o.strength * 100))
      if (o.softness !== undefined) $<HTMLInputElement>('soft').value = String(Math.round(o.softness * 100))
      syncSliders()
      setTool(t)
      const times: number[] = []
      for (let i = 0; i < n; i++) {
        const a = n > 1 ? i / (n - 1) : 0
        const x = x0 + (x1 - x0) * a, z = z0 + (z1 - z0) * a
        lastHit = new Vector3(x, ground(x, z) ?? 0, z)
        const s0 = performance.now()
        if (i === 0) beginStroke(!!o.shift)
        else stampNow()
        times.push(performance.now() - s0)
        gate.invalidate()
        await new Promise(r => setTimeout(r, 0))
      }
      endStroke()
      return { stamps: n, stampMsMean: times.reduce((s, v) => s + v, 0) / n, stampMsMax: Math.max(...times) }
    },
    /** The Walkable brush's mode (as the panel's buttons set it). */
    setWalkMode: (m: WalkMode) => {
      walkBrush = m
      for (const o of $('walkModes').querySelectorAll<HTMLButtonElement>('button')) o.classList.toggle('on', o.dataset.mode === m)
    },
    pickTile: (tile: number) => {
      const e = palette.find(p => p.tile === tile)
      if (e) pickTile(e)
      return !!e
    },
    async selectAt(region: number, uid: number) {
      await objects.select([`r:${region}:${uid}`])
      renderSelection()
      return objects.info()
    },
    get publish() { return publish },
    get tester() { return tester },
    /** Draws a run in the report panel (the user check shows a report without a Publish). */
    showReport: (run: PublishRunView) => showRun(run),
    /** The before / after pictures of views (default: the page's own), nothing sent: [{ view, label, before, after }]. */
    async takeShots(views?: SheetView[]) {
      const shots = await takeShots(views ?? sheetViews(session.history.changes), () => {})
      return shots.map(({ beforePng: _b, afterPng: _a, ...s }) => s)
    },
    showOriginal,
    stats: () => ({ drawn: gate.drawn, skipped: gate.skipped, draws, upload: link.stats, stamps: stampStats, changes: session.history.changes.length, unsaved: session.unsaved, shadows: shadows?.stats() ?? null, errors: errors.slice(-5) }),
    objectLabel,
  }
}

main().catch(err => {
  console.error(err)
  $('loading').textContent = `The World Editor could not start: ${(err as Error).message}`
})
