/**
 * Name-tag de-cluttering (docs/UX_GAPS.md F1, §4.4). Once per frame, after the world screen has placed every label
 * (EntityView.updateLabel), the visible labels are laid out in priority order: hovered, target, self, players, NPCs,
 * mobs attacking you, mobs by distance, items by distance. A label that overlaps one already placed is nudged up in
 * 14 px steps (at most 3); if it still overlaps it fades out (150 ms). At most 24 mob and 12 item labels show.
 * Beyond 25 m a mob shows only its name. `layoutPlates` is the pure part (tested without a DOM).
 */
import type { EntityView } from './entities.ts'

export const NUDGE_PX = 14
export const MAX_NUDGES = 3
export const MOB_LABEL_CAP = 24
export const ITEM_LABEL_CAP = 12
/** Mobs farther than this show their name only (no level). */
export const MOB_LEVEL_RANGE = 25

export type PlateKind = 'player' | 'npc' | 'mob' | 'item'

export interface PlateInput {
  id: number
  /** Label box in CSS pixels (left/top corner). */
  x: number
  y: number
  w: number
  h: number
  /** Higher first. */
  prio: number
  kind: PlateKind
  /** Never hidden (hovered, target, self). */
  pinned?: boolean
}

export interface PlateOutput {
  id: number
  /** Pixels moved up. */
  dy: number
  visible: boolean
}

/** Priority of a label (UX_GAPS §4.4 order); `dist` in metres breaks ties within a class (nearer first). */
export function platePriority(o: { hovered: boolean; target: boolean; self: boolean; kind: PlateKind; attackingMe: boolean; dist: number }): number {
  const near = Math.max(0, 1 - Math.min(o.dist, 999) / 1000)
  if (o.hovered) return 900
  if (o.target) return 800
  if (o.self) return 700
  switch (o.kind) {
    case 'player':
      return 500 + near
    case 'npc':
      return 400 + near
    case 'mob':
      return (o.attackingMe ? 300 : 200) + near
    default:
      return 100 + near
  }
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Greedy placement in priority order (pure). */
export function layoutPlates(items: readonly PlateInput[]): PlateOutput[] {
  const order = [...items].sort((a, b) => b.prio - a.prio)
  const placed: { x: number; y: number; w: number; h: number }[] = []
  const out: PlateOutput[] = []
  let mobs = 0
  let drops = 0
  for (const it of order) {
    const capped = !it.pinned && ((it.kind === 'mob' && mobs >= MOB_LABEL_CAP) || (it.kind === 'item' && drops >= ITEM_LABEL_CAP))
    let dy = -1
    if (!capped) {
      for (let step = 0; step <= MAX_NUDGES; step++) {
        const r = { x: it.x, y: it.y - step * NUDGE_PX, w: it.w, h: it.h }
        if (!placed.some(p => overlaps(p, r))) {
          dy = step * NUDGE_PX
          break
        }
      }
      if (dy < 0 && it.pinned) dy = 0
    }
    if (dy < 0) {
      out.push({ id: it.id, dy: 0, visible: false })
      continue
    }
    placed.push({ x: it.x, y: it.y - dy, w: it.w, h: it.h })
    if (it.kind === 'mob') mobs++
    else if (it.kind === 'item') drops++
    out.push({ id: it.id, dy, visible: true })
  }
  return out
}

/** The anchor EntityView.updateLabel placed the label at: `translate(Xpx, Ypx) translate(-50%, -100%)`. */
export function labelAnchor(label: { style: { transform: string } }): { x: number; y: number } | null {
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/.exec(label.style.transform)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

/** A label's box as NameplateLayout last laid it out: measured size, the applied nudge up (px), hidden (np-hide). */
export interface PlateBox {
  readonly w: number
  readonly h: number
  readonly dy: number
  readonly hidden: boolean
}

/** Per label element: its PlateBox (H11-CH-3: the town bubbles lay out against the tags as they are drawn). */
const boxes = new WeakMap<object, PlateBox>()

/** The box NameplateLayout last gave `label`; undefined when it has not laid it out. */
export function plateBox(label: object): PlateBox | undefined {
  return boxes.get(label)
}

interface PlateState {
  text: string
  w: number
  h: number
  dy: number
  hidden: boolean
  far: boolean
}

/** Applies layoutPlates to the live labels (DOM side; see the file header). */
export class NameplateLayout {
  /** Per label: measured size and what was applied last (the positions come from labelAnchor). */
  private readonly states = new WeakMap<EntityView, PlateState>()

  run(
    views: Iterable<EntityView>,
    o: {
      selfId: number | null
      target: EntityView | null
      hovered: EntityView | null
      focus: { x: number; z: number }
      attackers: ReadonlySet<number>
      /** Name-tag settings (Options → Interface): false hides that label unless hovered or targeted. */
      show?: (v: EntityView) => boolean
    },
  ): void {
    const inputs: PlateInput[] = []
    const byId = new Map<number, { v: EntityView; s: PlateState }>()
    for (const v of views) {
      const label = v.label
      let s = this.states.get(v)
      if (label.hidden || v.isDisposed) {
        if (s && (s.dy || s.hidden)) this.apply(v, s, 0, false)
        continue
      }
      if (o.show && v !== o.hovered && v !== o.target && !o.show(v)) {
        if (s) this.apply(v, s, 0, true)
        else {
          v.label.classList.add('np-hide')
          const hiddenState = { text: '', w: 0, h: 0, dy: 0, hidden: true, far: false }
          this.states.set(v, hiddenState)
          boxes.set(label, hiddenState)
        }
        continue
      }
      const text = label.textContent ?? ''
      if (!s || s.text !== text || s.w === 0) {
        s = { text, w: label.offsetWidth, h: label.offsetHeight, dy: s?.dy ?? 0, hidden: s?.hidden ?? false, far: s?.far ?? false }
        this.states.set(v, s)
        boxes.set(label, s)
      }
      const dist = Math.hypot(v.pos.x - o.focus.x, v.pos.z - o.focus.z)
      const far = v.kind === 'mob' && dist > MOB_LEVEL_RANGE && v !== o.target && v !== o.hovered
      if (far !== s.far) {
        s.far = far
        label.classList.toggle('np-far', far)
        s.w = label.offsetWidth
      }
      const p = labelAnchor(label)
      if (!p) continue
      const self = v.id === o.selfId
      const kind = v.kind as PlateKind
      inputs.push({
        id: v.id,
        x: p.x - s.w / 2,
        y: p.y - s.h,
        w: s.w,
        h: s.h,
        kind,
        pinned: v === o.hovered || v === o.target || self,
        prio: platePriority({ hovered: v === o.hovered, target: v === o.target, self, kind, attackingMe: o.attackers.has(v.id), dist }),
      })
      byId.set(v.id, { v, s })
    }
    for (const r of layoutPlates(inputs)) {
      const e = byId.get(r.id)
      if (e) this.apply(e.v, e.s, r.dy, !r.visible)
    }
  }

  private apply(v: EntityView, s: PlateState, dy: number, hidden: boolean): void {
    if (s.dy !== dy) {
      s.dy = dy
      v.label.style.translate = dy ? `0 ${-dy}px` : ''
    }
    if (s.hidden !== hidden) {
      s.hidden = hidden
      v.label.classList.toggle('np-hide', hidden)
    }
  }
}
