/**
 * UX-R (WAVE_PLAN §5.1): remaining UX. Pure parts only (vitest has no DOM and no GPU).
 */
import { describe, expect, it } from 'vitest'
import { bagTotals, freshSlots } from '../src/hud/inventory.ts'
import { ItemCatalog } from '../src/hud/items.ts'
import { OPTIONAL_ROWS } from '../src/hud/options.ts'
import { LOW_HP, lowHp } from '../src/hud/player.ts'
import { t } from '../src/i18n/index.ts'
import { LOADING_TIPS, nextTip } from '../src/screens/loading.ts'
import { SettingsStore, defaultSettings, normalizeSettings } from '../src/settings.ts'
import { FLOATING_BIND_M, standingHeight } from '../src/three/models.ts'
import { NEAREST_MOB_RADIUS, nearestMobs, nextMobTarget, type MobCandidate } from '../src/world/autoloot.ts'
import { QUARTER_ALPHA, SHAKE_S, TOUCH_TURN, angleDelta, behindAlpha, shakeOffset, twoFingerDelta } from '../src/world/camera-keys.ts'
import { CHAT_FADE_MS, chatTime } from '../src/world/chat.ts'
import { BUBBLE_MAX, bubbleText, hoverCursor } from '../src/world/features/ux-world.ts'
import { MAX_NUDGES, NUDGE_PX, layoutPlates, platePriority, type PlateInput } from '../src/world/nameplates.ts'
import { PICKUP_MATCH_MS, PickupMatcher } from '../src/world/pickup-fly.ts'

/** Pinhole camera looking along +Z, pitched down by `pitch`; returns CSS pixels on a w x h canvas. */
function project(p: { x: number; y: number; z: number }, cam: { x: number; y: number; z: number; pitch: number; fov: number; w: number; h: number }) {
  const dx = p.x - cam.x
  const dy = p.y - cam.y
  const dz = p.z - cam.z
  const c = Math.cos(cam.pitch)
  const s = Math.sin(cam.pitch)
  // Rotate into camera space (x right, y up, z forward).
  const vy = dy * c + dz * s
  const vz = -dy * s + dz * c
  const f = cam.h / 2 / Math.tan(cam.fov / 2)
  return { x: cam.w / 2 + (dx / vz) * f, y: cam.h / 2 - (vy / vz) * f }
}

describe('name-tag anchor (P0: a label must stay above its own head)', () => {
  // Storage-keeper Sansan (NPC_CH_WAREHOUSE_W): her glb is bound floating (2.37..4.06 m) and STAND1 pulls her down to
  // 1.24..2.73 m (measured with Babylon's CPU skinning on the converted glb).
  const sansan = { bind: { min: 2.37, max: 4.06 }, posed: { min: 1.24, max: 2.73 } }

  it('uses the bind-pose top for models bound on their feet (every player, almost every mob and NPC)', () => {
    expect(standingHeight({ min: 0, max: 1.78 })).toBeCloseTo(1.78)
    expect(standingHeight({ min: -0.02, max: 1.6 }, { min: 0, max: 5 })).toBeCloseTo(1.6)
    expect(standingHeight({ min: FLOATING_BIND_M, max: 2 })).toBeCloseTo(2)
  })

  it('uses the measured standing pose for a floating bind, and the bind extent until it is measured', () => {
    expect(standingHeight(sansan.bind, sansan.posed)).toBeCloseTo(2.73)
    expect(standingHeight(sansan.bind)).toBeCloseTo(4.06 - 2.37)
    expect(standingHeight(sansan.bind, null)).toBeCloseTo(4.06 - 2.37)
    // A flying bug hovers in its pose too: its label goes over its real top.
    expect(standingHeight({ min: 1.01, max: 2.61 }, { min: 1.01, max: 2.31 })).toBeCloseTo(2.31)
  })

  it('falls back to 1.8 m for absurd heights', () => {
    expect(standingHeight({ min: 0, max: 40 })).toBe(1.8)
    expect(standingHeight({ min: 0, max: 0.1 })).toBe(1.8)
    expect(standingHeight(sansan.bind, { min: 0, max: Number.NaN })).toBeCloseTo(4.06 - 2.37)
  })

  it('keeps the label anchor on the rendered head with the camera close behind the player', () => {
    // Camera 9 m behind and 5 m above the player, pitched 30 degrees down; Sansan in the bottom-right of the screen.
    const cam = { x: 0, y: 5, z: -9, pitch: (30 * Math.PI) / 180, fov: 0.8, w: 1280, h: 720 }
    const feet = { x: 3, y: 0, z: -2 }
    expect(project(feet, cam).y).toBeGreaterThan(cam.h / 2)
    const headTop = project({ ...feet, y: sansan.posed.max }, cam)
    const anchorAt = (height: number) => project({ ...feet, y: height + 0.2 }, cam)
    const before = anchorAt(standingHeight({ min: 0, max: sansan.bind.max }))
    const after = anchorAt(standingHeight(sansan.bind, sansan.posed))
    expect(headTop.x).toBeGreaterThan(cam.w / 2)
    // The old rule (bind-pose top) drew the tag hundreds of pixels up and to the right of her head.
    expect(headTop.y - before.y).toBeGreaterThan(150)
    expect(before.x - headTop.x).toBeGreaterThan(20)
    // Now it sits just above her head: 0.2 m of margin, a few tens of pixels at most.
    expect(headTop.y - after.y).toBeGreaterThan(0)
    expect(headTop.y - after.y).toBeLessThan(40)
    expect(Math.abs(after.x - headTop.x)).toBeLessThan(10)
  })

  it('stacking only nudges a label up a little, never sideways and never far', () => {
    const plate = (id: number, x: number, y: number, extra: Partial<PlateInput> = {}): PlateInput => ({
      id, x, y, w: 120, h: 16, kind: 'npc', prio: platePriority({ hovered: false, target: false, self: false, kind: 'npc', attackingMe: false, dist: id }), ...extra,
    })
    // A crowded plaza: 40 tags piled on nearly the same spot, one pinned (target).
    const crowd = Array.from({ length: 40 }, (_, i) => plate(i + 1, 600 + (i % 5) * 7, 400 + (i % 3) * 5))
    crowd.push(plate(99, 600, 400, { pinned: true, prio: 800 }))
    const out = layoutPlates(crowd)
    expect(out).toHaveLength(crowd.length)
    for (const o of out) {
      expect(o.dy).toBeGreaterThanOrEqual(0)
      expect(o.dy).toBeLessThanOrEqual(MAX_NUDGES * NUDGE_PX)
      expect(o.dy % NUDGE_PX).toBe(0)
    }
    expect(out.find(o => o.id === 99)).toEqual({ id: 99, dy: 0, visible: true })
  })
})

describe('Z: nearest monster (K8)', () => {
  const mob = (id: number, x: number, z: number, extra: Partial<MobCandidate> = {}): MobCandidate => ({
    id, kind: 'mob', pos: { x, z }, isDisposed: false, fading: false, dead: false, dying: false, ...extra,
  })
  const self = { x: 0, z: 0 }
  const views = [
    mob(1, 10, 0),
    mob(2, 3, 0),
    mob(3, 0, 20),
    mob(4, 1, 1, { dead: true }),
    mob(5, 2, 0, { dying: true }),
    mob(6, 30, 0),
    { ...mob(7, 1, 0), kind: 'npc' },
    mob(8, 0, 3),
  ]

  it('lists living monsters in range, nearest first, ties by id', () => {
    expect(nearestMobs(views, self).map(v => v.id)).toEqual([2, 8, 1, 3])
    expect(nearestMobs(views, self, 5).map(v => v.id)).toEqual([2, 8])
    expect(NEAREST_MOB_RADIUS).toBe(25)
  })

  it('picks the nearest, then cycles farther and wraps back', () => {
    expect(nextMobTarget(views, self, null)?.id).toBe(2)
    expect(nextMobTarget(views, self, { id: 2 })?.id).toBe(8)
    expect(nextMobTarget(views, self, { id: 8 })?.id).toBe(1)
    expect(nextMobTarget(views, self, { id: 3 })?.id).toBe(2)
    // A target out of the list (too far, or not a mob) starts over at the nearest.
    expect(nextMobTarget(views, self, { id: 6 })?.id).toBe(2)
    expect(nextMobTarget([], self, null)).toBeNull()
  })
})

describe('camera modes and shake (K7, F11)', () => {
  it('turns the short way round', () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2)
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2)
    expect(angleDelta(0.1, 0.1 + Math.PI * 4)).toBeCloseTo(0)
    expect(Math.abs(angleDelta(-3, behindAlpha(1)))).toBeLessThanOrEqual(Math.PI)
  })

  it('quarter view looks north-west from the south-east', () => {
    // ArcRotate camera position = target + (cos a, _, sin a): +x east, +z south.
    expect(Math.cos(QUARTER_ALPHA)).toBeGreaterThan(0)
    expect(Math.sin(QUARTER_ALPHA)).toBeGreaterThan(0)
  })

  it('shakes briefly and settles at zero', () => {
    const start = shakeOffset(SHAKE_S)
    expect(Math.hypot(start.x, start.y)).toBeLessThan(0.2)
    expect(shakeOffset(0)).toEqual({ x: 0, y: 0 })
    expect(Math.abs(shakeOffset(0.01).x)).toBeLessThan(0.01)
  })

  it('keeps the new options and lists their rows', () => {
    const store = new SettingsStore(null)
    expect(store.get().controls.cameraShake).toBe(true)
    store.set({ controls: { cameraShake: false, cameraMode: 'quarter' } })
    expect(store.get().controls).toMatchObject({ cameraShake: false, cameraMode: 'quarter' })
    expect(normalizeSettings({ controls: { cameraShake: 'yes' } }).controls.cameraShake).toBe(defaultSettings().controls.cameraShake)
    for (const id of ['controls.cameraMode', 'controls.nearestTargetKey', 'controls.cameraShake']) expect(OPTIONAL_ROWS.has(id), id).toBe(true)
  })
})

describe('chat bubbles, fade and cursors (C8, C9, K10)', () => {
  it('shows one tidy line, capped', () => {
    expect(bubbleText('  hello\n  there  ')).toBe('hello there')
    const long = bubbleText('x'.repeat(200))
    expect(long.length).toBe(BUBBLE_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(bubbleText('   ')).toBe('')
  })

  it('stamps lines and fades after 10 s', () => {
    expect(chatTime(new Date(2026, 8, 28, 7, 5))).toBe('07:05')
    expect(CHAT_FADE_MS).toBe(10_000)
  })

  it('picks a cursor per entity kind', () => {
    expect(hoverCursor(null)).toBe('')
    expect(hoverCursor({ kind: 'mob' })).toBe('mob')
    expect(hoverCursor({ kind: 'npc' })).toBe('npc')
    expect(hoverCursor({ kind: 'item' })).toBe('item')
    expect(hoverCursor({ kind: 'player' })).toBe('player')
  })
})

describe('bag, tooltips, HP warning, loading tips (W5, W9, H7, L5)', () => {
  const s = (code: string, count = 1) => ({ code, count })

  it('marks only slots whose item really arrived', () => {
    const before = [s('A', 2), null, s('B'), null]
    // A pickup stacks onto A, a new C lands in slot 1.
    expect(freshSlots(before, [s('A', 3), s('C'), s('B'), null], [0, 1])).toEqual([0, 1])
    // Moving B from slot 2 to 3 is not new.
    expect(freshSlots(before, [s('A', 2), null, null, s('B')], [2, 3])).toEqual([])
    // Splitting A (2) into 1 + 1 is not new.
    expect(freshSlots(before, [s('A', 1), s('A', 1), s('B'), null], [0, 1])).toEqual([])
    // Taking off an equipped sword: the bag gains it, the totals with equipment do not.
    const was = new Map([['A', 2], ['B', 1], ['SWORD', 1]])
    const now = new Map([['A', 2], ['B', 1], ['SWORD', 1]])
    expect(freshSlots(before, [s('A', 2), s('SWORD'), s('B'), null], [1], was, now)).toEqual([])
    expect(bagTotals([s('A', 2), null, s('A', 3)]).get('A')).toBe(5)
  })

  it('gives a +N item a light-blue title and keeps normal items plain', () => {
    const cat = new ItemCatalog()
    expect(cat.tooltip({ code: 'ITEM_X', count: 1, plus: 3 })[0]?.cls).toBe('title-plus')
    expect(cat.tooltip({ code: 'ITEM_X', count: 1 })[0]?.cls).toBe('title')
  })

  it('warns below 25% HP, alive only', () => {
    expect(LOW_HP).toBe(0.25)
    expect(lowHp(24, 100)).toBe(true)
    expect(lowHp(25, 100)).toBe(false)
    expect(lowHp(0, 100)).toBe(false)
    expect(lowHp(10, 0)).toBe(false)
  })

  it('rotates tips without repeating one twice in a row', () => {
    for (const key of LOADING_TIPS) expect(t(key)).not.toBe(key)
    const n = LOADING_TIPS.length
    for (let prev = -1; prev < n; prev++) {
      for (const r of [0, 0.3, 0.5, 0.99, 1]) {
        const i = nextTip(prev, r)
        expect(i).toBeGreaterThanOrEqual(0)
        expect(i).toBeLessThan(n)
        expect(i).not.toBe(prev)
      }
    }
    expect(nextTip(0, 0.5, 1)).toBe(0)
  })
})

describe('pickup feedback (F9)', () => {
  const at = { x: 400, y: 300 }

  it('matches a vanished item with the bag update, in either order', () => {
    const m = new PickupMatcher()
    expect(m.removedNear('ITEM_A', at, 0)).toBeNull()
    expect(m.arrived(['ITEM_A'], false, 200)).toEqual([{ code: 'ITEM_A', from: at }])
    expect(m.arrived(['ITEM_B'], false, 1000)).toEqual([])
    expect(m.removedNear('ITEM_B', at, 1300)).toEqual({ code: 'ITEM_B', from: at })
    // Each side is used once.
    expect(m.removedNear('ITEM_B', at, 1400)).toBeNull()
  })

  it('matches gold by the gold total changing, and forgets after a moment', () => {
    const m = new PickupMatcher()
    expect(m.removedNear('ITEM_ETC_GOLD_01', at, 0)).toBeNull()
    expect(m.arrived([], true, 100)).toEqual([{ code: 'ITEM_ETC_GOLD_01', from: at }])
    expect(m.removedNear('ITEM_C', at, 0)).toBeNull()
    expect(m.arrived(['ITEM_C'], false, PICKUP_MATCH_MS + 1)).toEqual([])
  })
})

describe('two-finger touch camera (R7)', () => {
  it('turns with a sideways drag and zooms with a pinch', () => {
    const turn = twoFingerDelta({ x: 100, y: 300 }, { x: 200, y: 300 }, { x: 150, y: 300 }, { x: 250, y: 300 })
    expect(turn.turn).toBeCloseTo(-50 * TOUCH_TURN)
    expect(turn.zoom).toBeCloseTo(1)
    const pinchOut = twoFingerDelta({ x: 100, y: 300 }, { x: 200, y: 300 }, { x: 50, y: 300 }, { x: 250, y: 300 })
    expect(pinchOut.turn).toBeCloseTo(0)
    expect(pinchOut.zoom).toBeCloseTo(0.5)
    // Fingers on top of each other: no zoom jump.
    expect(twoFingerDelta({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0 }, { x: 200, y: 0 }).zoom).toBe(1)
  })
})
