/**
 * H7B adversarial hunt, lens "robust" (docs/WAVE_PLAN2.md §5.15): mount points with nothing registered, malformed or
 * extreme server frames that the strict validator lets through, and the per-preset effect switches.
 *
 * FINDINGS (fixed in 7B-fix; these tests pin the fixes):
 *  - R1 hitSprites throws on a damage number the validator accepts (`int(…, 0, Number.MAX_VALUE)` lets 1e21 through;
 *    String(1e21) is "1e+21" and the 'e' has no ink row). In world.ts presentHit the throw comes before killView, so a
 *    killing blow with such a number leaves the victim standing, unpickable ("dying") and never dead on screen.
 *  - R2 WorldObjects.enableAmbient is not last-call-wins: turning ambient effects off (Graphics preset Low) while an
 *    earlier enable is still loading ambient.json leaves the effects ON; fx-world's onFrame never retries because its
 *    `ambientMax` already equals the new budget.
 *
 * The other tests pin behaviour the hunt checked and found correct (kept as regression guards).
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { parseServerMessage } from '@sro/shared'
import { WorldObjects } from '@sro/world-render'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { hitSprites } from '../src/hud/hitcount.ts'
import { dialogOptions } from '../src/hud/shop-logic.ts'
import { slotSigns } from '../src/hud/slots.ts'
import { TargetActions } from '../src/hud/target.ts'
import { menuItems } from '../src/hud/menu-items.ts'
import { isFreshDrop, tossOffset } from '../src/world/drops.ts'
import { itemEffectOf } from '../src/world/features/fx-world.ts'
import { FX_BUDGETS, fxBudget } from '../src/world/fx/quality.ts'
import { groupHandle, phaseRows, readSystemGroups, SystemFx } from '../src/world/fx/system-fx.ts'

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
  vi.restoreAllMocks()
})

// ---- R1 ---------------------------------------------------------------------------------------------------------

describe('R1: damage numbers from validated frames never throw', () => {
  it('the validator accepts a combat hit of 1e21 damage (int up to Number.MAX_VALUE)', () => {
    const frame = JSON.stringify({ t: 'combat', attacker: 1, target: 2, hits: [{ outcome: 'hit', damage: 1e21, hp: 0 }], killed: true })
    const r = parseServerMessage(frame)
    expect(r.ok).toBe(true)
  })

  it('hitSprites lays such a number out instead of throwing (FAILS today: TypeError on the "e" of "1e+21")', () => {
    for (const kind of ['dealt', 'taken', 'crit', 'critTaken'] as const) {
      expect(() => hitSprites(1e21, kind)).not.toThrow()
    }
  })

  it('hitSprites survives NaN / Infinity from a client-side computation (FAILS today: "NaN" / "Infinity" have no digit ink)', () => {
    expect(() => hitSprites(Number.NaN, 'dealt')).not.toThrow()
    expect(() => hitSprites(Number.POSITIVE_INFINITY, 'dealt')).not.toThrow()
  })

  it('checked safe: ordinary and long numbers lay out (9 digits max)', () => {
    expect(hitSprites(0, 'dealt')!.sprites.length).toBeGreaterThan(0)
    expect(hitSprites(123456789012, 'taken')!.sprites.filter(s => /enemy_\d$/.test(s.key)).length).toBe(9)
    expect(hitSprites(-5, 'dealt')!.sprites.length).toBeGreaterThan(0)
    expect(hitSprites(5, 'heal')).toBeNull()
  })
})

// ---- R2 ---------------------------------------------------------------------------------------------------------

interface Deferred {
  resolve: (v: unknown) => void
}

function slowAssets(): { assets: { json: <T>(rel: string) => Promise<T> }; pending: Deferred[] } {
  const pending: Deferred[] = []
  return {
    pending,
    assets: {
      json: <T>() =>
        new Promise<T>(resolve => {
          pending.push({ resolve: resolve as (v: unknown) => void })
        }),
    },
  }
}

describe('R2: ambient effects follow the last enable/disable call', () => {
  it('disable while an enable is still loading ambient.json leaves the pool OFF (FAILS today: the stale enable wins)', async () => {
    const { assets, pending } = slowAssets()
    const objects = new WorldObjects(scene, assets as never, null as never)
    const play = vi.fn(() => ({ stop() {} }))
    // Frame N: preset High → enable with 40.
    const first = objects.enableAmbient(play, { max: 40 })
    // Frame N+1: the player picked Low → off (fx-world onFrame: max 0 → enableAmbient(null)).
    await objects.enableAmbient(null)
    expect(objects.ambientFx).toBeNull()
    // ambient.json arrives for the first call.
    pending[0]!.resolve({ models: {} })
    await first
    expect(objects.ambientFx).toBeNull()
  })

  it('two enables in flight (High → Medium) end with the later budget (FAILS today when the first load finishes last)', async () => {
    const { assets, pending } = slowAssets()
    const objects = new WorldObjects(scene, assets as never, null as never)
    const play = () => ({ stop() {} })
    const high = objects.enableAmbient(play, { max: 40 })
    const medium = objects.enableAmbient(play, { max: 20 })
    pending[1]!.resolve({ models: {} })
    await medium
    pending[0]!.resolve({ models: {} })
    await high
    expect(objects.ambientFx?.max).toBe(20)
  })
})

// ---- R3 ---------------------------------------------------------------------------------------------------------

describe('R3: the Low preset budget also covers NPC / mob model ambient particles', () => {
  it('an NPC model with an ambient sidecar particle starts no looping effect on Low (FAILS today: MAX_AMBIENT_MODELS ignores fxBudget)', async () => {
    const { settings } = await import('../src/settings.ts')
    const { fxWorldFeature } = await import('../src/world/features/fx-world.ts')
    const { systemFxFor } = await import('../src/world/fx/system-fx.ts')
    const { TransformNode } = await import('@babylonjs/core')
    const SIDE = '/out/npc/test_glow.json'
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (u: string | URL) => {
      if (String(u) === SIDE) return new Response(JSON.stringify({ particles: [{ kind: 'ambient', efp: 'map/frame.efp', position: [0, 1, 0] }] }))
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const prev = settings.get().graphics.preset
    try {
      settings.set({ graphics: { preset: 'low' } })
      expect(fxBudget().ambientMax).toBe(0)
      const own = new Scene(engine)
      const factories: ((v: unknown) => { loaded?(): void; dispose(): void } | null)[] = []
      const ctx = { scene: own, addAttachment: (f: (typeof factories)[number]) => (factories.push(f), () => {}), world: () => null }
      const feature = fxWorldFeature(ctx as never)
      const plays = vi.spyOn(systemFxFor(own).runner, 'play')
      const root = new TransformNode('npcRoot', own)
      const view = { kind: 'npc', id: 7, isSelf: false, dead: false, state: { model: 'NPC_TEST', posture: undefined }, actor: { model: { sidecar: SIDE }, root, joint: () => undefined, isDisposed: false, onClip: undefined, clips: new Map(), clipFor: () => undefined, idleVariants: () => [] }, setIdle() {} }
      const atts = factories.map(f => f(view)).filter(a => a !== null)
      for (const a of atts) a!.loaded?.()
      await new Promise(r => setTimeout(r, 20))
      expect(plays.mock.calls.filter(c => c[1]?.loop).length).toBe(0)
      for (const a of atts) a!.dispose()
      feature.dispose?.()
      own.dispose()
    } finally {
      settings.set({ graphics: { preset: prev } })
      globalThis.fetch = realFetch
    }
  })
})

// ---- checked safe: malformed / extreme 7B frames --------------------------------------------------------------------

describe('checked safe: 7B frames through the client validator', () => {
  const bad = [
    { t: 'itemEffect', id: 1 },
    { t: 'itemEffect', id: -1, item: 'ITEM_ETC_HP_POTION_01' },
    { t: 'itemEffect', id: 1, item: '' },
    { t: 'itemEffect', id: 1, item: 'x'.repeat(129) },
    { t: 'itemEffect', id: '1', item: 'ITEM_ETC_HP_POTION_01' },
    { t: 'emote', id: 1, emote: 'dance' },
    { t: 'emote', id: 1, emote: '__proto__' },
    { t: 'emote', id: 1 },
    { t: 'entityUpdate', id: 1, posture: 'lie' },
    { t: 'entityUpdate', id: 1, posture: 1 },
  ]
  for (const m of bad) {
    it(`drops ${JSON.stringify(m).slice(0, 60)}`, () => {
      expect(parseServerMessage(JSON.stringify(m)).ok).toBe(false)
    })
  }

  it('an unknown or prototype item code in itemEffect maps to no effect', () => {
    expect(itemEffectOf(undefined)).toBeNull()
    expect(itemEffectOf(Object.prototype as never)).toBeNull()
  })

  it('droppedAt far in the past/future or huge is never a toss; a huge dropFrom only offsets the arc', () => {
    expect(isFreshDrop(Number.MAX_VALUE, 1000)).toBe(false)
    expect(isFreshDrop(0, Number.MAX_VALUE)).toBe(false)
    expect(isFreshDrop(undefined, 0)).toBe(false)
    const o = tossOffset(0.5, [1e300, 0, -1e300])
    expect(o.every(Number.isFinite)).toBe(true)
    expect(tossOffset(1, [1e300, 0, 0])).toEqual([0, 0, 0])
  })
})

// ---- checked safe: mount points with nothing registered (M3, M7, M9, M15) --------------------------------------------

describe('checked safe: mount points with nothing registered', () => {
  it('M3: no actions → none shown; a throwing show hides only itself', () => {
    const a = new TargetActions()
    expect(a.visible({ kind: 'player' } as never)).toEqual([])
    const off = a.add({ id: 'boom', label: 'X', show: () => { throw new Error('x') }, run() {} } as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(a.visible({ kind: 'player' } as never)).toEqual([])
    off()
    expect(a.all).toEqual([])
  })

  it('M7: a server-offered guild service without a handler is not listed; repair never is', () => {
    expect(dialogOptions(['shop', 'repair', 'guild', 'guild'])).toEqual(['shop'])
  })

  it('M9: no decorators → the plain signs', () => {
    const s = slotSigns({ code: 'ITEM_CH_SWORD_01_A_DEF', count: 1 } as never, undefined)
    expect(s.plus).toBe(0)
  })

  it('the Esc menu has its built-in rows without any feature', () => {
    expect(menuItems().map(m => m.id)).toEqual(expect.arrayContaining(['characterSelect', 'logout', 'resume']))
  })

  it('M15: SystemFx.play of a wave-8 key with no rows returns a finished handle, stop() is safe', () => {
    const fx = new SystemFx(scene, { groups: readSystemGroups({ skills: [] }) })
    const view = { yaw: 0, scale: 1, actor: null, root: { computeWorldMatrix() {}, getAbsolutePosition: () => ({ x: 0, y: 0, z: 0 }) } }
    for (const key of ['SYSTEM_CH_HWANMODE', 'SYSTEM_PET_APPEAR', 'SYSTEM_COS_HPPOTION']) {
      for (const phase of ['start', 'loop', 'end'] as const) {
        const h = fx.play(key, phase, view as never)
        h.stop()
        h.stop()
      }
    }
    expect(phaseRows(undefined, 'loop')).toEqual([])
    expect(groupHandle([]).done).toBe(true)
    fx.dispose()
  })

  it('effect budgets: an unknown preset falls back to high', () => {
    expect(fxBudget('bogus' as never)).toBe(FX_BUDGETS.high)
    expect(FX_BUDGETS.low.ambientMax).toBe(0)
  })
})
