/**
 * Wave 11 (docs/TOWN_LIFE.md §3.6–§3.7, §6; docs/WAVE_PLAN7.md §6.1 lane TL-C, D11, D22): the town's app side.
 *
 * - **Speech bubbles**: a pool of MAX_BUBBLES DOM bubbles in the entity-label layer, filled each frame from
 *   `World.town.bubbles()` (vendor calls within 20 m, the clicked townsperson's answer first), projected to the head
 *   and laid out with `layoutPlates` against the name tags near them (the tags are pinned; a bubble is nudged up, or
 *   hidden when it still overlaps), so a bubble never covers a name tag. English content lines (the town file's).
 * - **The click**: ux-world's `addTownPick` runs after the entity and item picks and **never consumes the click**
 *   (the player still walks to the clicked ground, F9); a townsperson under the pointer within 25 m answers with a
 *   flavour line (local: no server message). Over a townsperson the cursor is the speech cursor (`hover`).
 * - **The cap gives way to players**: twice a second the player characters within the crowd's range go to
 *   `World.town.setPlayers` (TOWN_LIFE §8.1: −3 townsfolk per player beyond 5).
 * - **Town sound** (TL-S): a new vendor call plays the murmur at the vendor (`TownAudio.vendorCall`; the bed's own
 *   stall murmurs step aside while the crowd draws), and the bed counts the folk the crowd draws near the listener.
 *
 * The town part is World's (packages/world-render town/index.ts, duck-typed here as `TownApp`); the clock, the threats
 * and the alarm reach it from world/graphics.ts and screens/world.ts (W11-G).
 */
import { Vector3, type Scene } from '@babylonjs/core'
import { toScreen } from '../../three/project.ts'
import type { WorldFeatureContext, WorldFeatureFactory } from '../features.ts'
import { worldTown } from '../graphics.ts'
import { layoutPlates, labelAnchor, plateBox, type PlateInput } from '../nameplates.ts'
import { activeTownAudio, scheduleFolkCounter, setTownFolkCounter } from './town-sound.ts'
import { addTownPick } from './ux-world.ts'

/** Bubbles on screen at most (bubbles.ts MAX_BUBBLES). */
export const TOWN_BUBBLES = 3
/** How often the players in range are counted (s). */
export const PLAYER_COUNT_S = 0.5
/**
 * A name tag's box for the layout (px) when neither the plate layout nor an earlier frame measured it. H11-CH-3: the
 * box is the tag as drawn (NameplateLayout's measured size and nudge, nameplates.ts plateBox); else the tag is measured
 * once per text (no forced layout per frame) and its nudge read from `style.translate`.
 */
const TAG_W = 120
const TAG_H = 18
/** Tags this feature measured itself (no plate layout), per text. */
const measured = new WeakMap<object, { text: string; w: number; h: number }>()

/** The drawn box of a name tag: size and nudge up (px); null when the tag is hidden by the plate layout. */
function tagBox(label: HTMLElement): { w: number; h: number; dy: number } | null {
  const box = plateBox(label)
  if (box?.hidden) return null
  if (box && box.w > 0) return { w: box.w, h: box.h || TAG_H, dy: box.dy }
  const text = label.textContent ?? ''
  let m = measured.get(label)
  if (!m || m.text !== text) {
    m = { text, w: label.offsetWidth || TAG_W, h: label.offsetHeight || TAG_H }
    measured.set(label, m)
  }
  const t = /^0 (-?[\d.]+)px$/.exec(label.style.translate ?? '')
  return { w: m.w, h: m.h, dy: t ? -Number(t[1]) : 0 }
}
/** Name tags farther than this from every bubble anchor are not looked at (px). */
const TAG_NEAR_PX = 260

/** A bubble as the town part fills it (town/bubbles.ts TownBubble, structurally). */
export interface TownBubbleLike {
  agent: number
  text: string
  x: number
  y: number
  z: number
  dist: number
  click: boolean
}

/** What this feature reads from World.town (town/index.ts TownLife; absent methods: a stub part). */
export interface TownApp {
  bubbles?(out: TownBubbleLike[]): number
  pickFolk?(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number
  say?(agent: number): boolean
  setPlayers?(n: number): void
  folkNear?(x: number, z: number, r: number): number
  readonly range?: number
  readonly enabled?: boolean
  /**
   * False while the part draws no folk though enabled (cut 20: the crowd gives way to the players). Optional: a part
   * without it counts as drawing while enabled.
   */
  readonly drawsFolk?: boolean
}

const CSS = `
.town-bubble {
  position: absolute; left: 0; top: 0; width: max-content; max-width: 200px; padding: 3px 8px;
  white-space: normal; overflow-wrap: anywhere; text-align: center;
  font: 12px/15px var(--font-body); color: #2a2110; text-shadow: none;
  background: rgba(255, 246, 214, 0.94); border: 1px solid #8a6d35; border-radius: 8px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  pointer-events: none; transition: opacity 150ms linear;
}
.town-bubble::after {
  content: ''; position: absolute; left: 50%; top: 100%; margin-left: -5px;
  border: 5px solid transparent; border-top-color: #8a6d35;
}
.town-bubble.tb-hide { opacity: 0; }
.town-bubble.tb-click { border-color: #5d4520; }
`

let styled = false

function ensureStyles(): void {
  if (styled || typeof document === 'undefined') return
  styled = true
  const style = document.createElement('style')
  style.dataset.owner = 'town'
  style.textContent = CSS
  document.head.append(style)
}

/** One DOM bubble of the pool and what it shows. */
interface Slot {
  el: HTMLDivElement
  text: string
  w: number
  h: number
  shown: boolean
  click: boolean
}

/** The town part of the world being shown (null: none, Classic, or a stub without the bubble API). */
function townOf(ctx: WorldFeatureContext): TownApp | null {
  const t = worldTown(ctx.world()?.world) as TownApp | null
  return t && typeof t.bubbles === 'function' ? t : null
}

export const townFeature: WorldFeatureFactory = ctx => {
  // A bare context (the seam tests) has no scene: nothing to do.
  if (!ctx || !ctx.scene) return {}
  const scene: Scene = ctx.scene
  const pool: TownBubbleLike[] = Array.from({ length: 8 }, () => ({ agent: -1, text: '', x: 0, y: 0, z: 0, dist: 0, click: false }))
  const slots: Slot[] = []
  let layer: HTMLElement | null = null
  let countT = 0
  let lastCalls = new Map<number, string>()
  let spareCalls = new Map<number, string>()
  /** The crowd whose count the bed hears; null: the pure schedule's; undefined: nothing plugged yet. */
  let counterFor: TownApp | null | undefined
  const head = new Vector3()
  const ray = { origin: new Vector3(), direction: new Vector3() }

  /** The DOM pool, made on first use in the entity-label layer (none in node tests). */
  const ensureSlots = (): boolean => {
    if (slots.length) return true
    if (typeof document === 'undefined') return false
    layer = document.querySelector<HTMLElement>('.entity-labels')
    if (!layer) return false
    ensureStyles()
    for (let i = 0; i < TOWN_BUBBLES; i++) {
      const el = document.createElement('div')
      el.className = 'town-bubble tb-hide'
      layer.append(el)
      slots.push({ el, text: '', w: 0, h: 0, shown: false, click: false })
    }
    return true
  }

  const hide = (s: Slot) => {
    if (!s.shown) return
    s.shown = false
    s.el.classList.add('tb-hide')
  }

  /** A view ray through screen point (px, py) into ray (the pick); false without a camera. */
  const rayAt = (px: number, py: number): boolean => {
    const cam = scene.activeCamera
    if (!cam) return false
    const r = scene.createPickingRay(px, py, null, cam)
    ray.origin.copyFrom(r.origin)
    ray.direction.copyFrom(r.direction)
    return true
  }

  const pickAt = (town: TownApp, px: number, py: number): number => {
    if (!town.pickFolk || !rayAt(px, py)) return -1
    const o = ray.origin
    const d = ray.direction
    return town.pickFolk(o.x, o.y, o.z, d.x, d.y, d.z)
  }

  const offPick = addTownPick({
    // After the world screen's own click (its move intent already sent); returns nothing: never consumes it.
    click: (px, py) => {
      const town = townOf(ctx)
      if (!town) return
      const i = pickAt(town, px, py)
      if (i >= 0) town.say?.(i)
    },
    hover: (px, py) => {
      const town = townOf(ctx)
      return !!town && pickAt(town, px, py) >= 0
    },
  })

  /** Players within the crowd's range of the own character (self included). */
  const countPlayers = (town: TownApp): void => {
    const self = ctx.selfId()
    const me = self !== null ? ctx.view(self) : undefined
    if (!me) return
    const r = town.range && town.range > 0 ? town.range : 60
    let n = 0
    for (const v of ctx.views()) {
      if (v.kind !== 'player' || v.isDisposed) continue
      if ((v.pos.x - me.pos.x) ** 2 + (v.pos.z - me.pos.z) ** 2 <= r * r) n++
    }
    town.setPlayers?.(n)
  }

  /** The bed counts the folk the crowd draws (TL-S's counter) while a crowd is there; its own estimate otherwise. */
  const syncCounter = (town: TownApp | null): void => {
    // H11 S3 / LOW-1 (TOWN_LIFE §6, §8.2; WAVE_PLAN7 D23): the drawn crowd counts, and its bubbles make the vendors'
    // murmurs, only while it draws folk. Otherwise (Low: no part; Town life Off; cut 20) the pure schedule counts and
    // the built-in stall murmurs play: the town keeps its sound.
    const crowd = town?.folkNear && town.enabled !== false && town.drawsFolk !== false ? town : null
    if (crowd === counterFor) return
    counterFor = crowd
    if (crowd) setTownFolkCounter((x, z, r) => crowd.folkNear?.(x, z, r) ?? 0)
    else setTownFolkCounter(scheduleFolkCounter)
    activeTownAudio()?.setExternal({ calls: !!crowd })
  }

  return {
    onFrame(_now, dt) {
      const town = townOf(ctx)
      syncCounter(town)
      if (!town) {
        for (const s of slots) hide(s)
        return
      }
      countT -= dt
      if (countT <= 0) {
        countT = PLAYER_COUNT_S
        countPlayers(town)
      }
      const n = town.bubbles!(pool)
      // A vendor call that just started: its murmur at the vendor (TL-S), once per call.
      const calls = spareCalls
      calls.clear()
      for (let i = 0; i < n; i++) {
        const b = pool[i]!
        if (b.click) continue
        calls.set(b.agent, b.text)
        if (lastCalls.get(b.agent) !== b.text) activeTownAudio()?.vendorCall({ x: b.x, y: b.y, z: b.z })
      }
      spareCalls = lastCalls
      lastCalls = calls
      if (n === 0) {
        for (const s of slots) hide(s)
        return
      }
      if (!ensureSlots()) return
      // Project, measure on a text change, lay out against the name tags near them.
      const inputs: PlateInput[] = []
      const anchors: Array<{ x: number; y: number } | null> = []
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!
        const b = i < n ? pool[i]! : null
        if (!b) {
          anchors.push(null)
          continue
        }
        head.set(b.x, b.y, b.z)
        const p = toScreen(scene, head)
        if (!p.visible) {
          anchors.push(null)
          continue
        }
        if (s.text !== b.text) {
          s.text = b.text
          s.el.textContent = b.text
          s.w = s.el.offsetWidth || 120
          s.h = (s.el.offsetHeight || 20) + 6
        }
        if (s.click !== b.click) {
          s.click = b.click
          s.el.classList.toggle('tb-click', b.click)
        }
        anchors.push({ x: p.x, y: p.y })
        inputs.push({ id: -1 - i, x: p.x - s.w / 2, y: p.y - s.h, w: s.w, h: s.h, prio: (b.click ? 300 : 200) - b.dist, kind: 'npc' })
      }
      if (inputs.length) {
        for (const v of ctx.views()) {
          const label = v.label
          if (!label || label.hidden || v.isDisposed) continue
          const a = labelAnchor(label)
          if (!a) continue
          if (!inputs.some(b => Math.abs(b.x + b.w / 2 - a.x) < TAG_NEAR_PX && Math.abs(b.y + b.h - a.y) < TAG_NEAR_PX)) continue
          const t = tagBox(label)
          if (!t) continue
          inputs.push({ id: v.id, x: a.x - t.w / 2, y: a.y - t.dy - t.h, w: t.w, h: t.h, prio: 1000, kind: 'player', pinned: true })
        }
      }
      const placed = new Map<number, { dy: number; visible: boolean }>()
      for (const r of layoutPlates(inputs)) if (r.id < 0) placed.set(-1 - r.id, r)
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!
        const a = anchors[i]
        const r = placed.get(i)
        if (!a || !r || !r.visible) {
          hide(s)
          continue
        }
        s.el.style.transform = `translate(${a.x.toFixed(1)}px, ${(a.y - r.dy - 6).toFixed(1)}px) translate(-50%, -100%)`
        if (!s.shown) {
          s.shown = true
          s.el.classList.remove('tb-hide')
        }
      }
    },
    dispose() {
      offPick()
      if (counterFor !== undefined) {
        setTownFolkCounter(null)
        activeTownAudio()?.setExternal({ calls: false })
        counterFor = undefined
      }
      for (const s of slots) s.el.remove()
      slots.length = 0
      layer = null
    },
  }
}
