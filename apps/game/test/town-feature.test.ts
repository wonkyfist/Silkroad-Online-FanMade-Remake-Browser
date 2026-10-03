/**
 * TL-C, the town feature (docs/TOWN_LIFE.md §3.6–§3.7, §8.1; docs/WAVE_PLAN7.md §6.1 TL-C, D11): a click on a walking
 * townsperson still moves the player (the town pick runs after the world screen's move intent and never consumes the
 * click) and the townsperson answers; the speech cursor over one; the players in range reach the crowd's cap; the
 * feature leaves nothing registered when the world screen goes.
 */
import { ArcRotateCamera, NullEngine, PointerEventTypes, Scene, Vector3, type PointerInfo } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { townFeature, type TownApp } from '../src/world/features/town.ts'
import { runTownClick, runTownHover, townPickCount } from '../src/world/features/ux-world.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** A town part that records the feature's calls: a townsperson stands on the line x = 0 in front of the camera. */
class FakeTown implements TownApp {
  readonly said: number[] = []
  players = -1
  readonly range = 60
  readonly enabled = true
  bubbles(): number {
    return 0
  }

  pickFolk(ox: number, _oy: number, _oz: number, dx: number, _dy: number, _dz: number): number {
    // the ray from the camera passes x = 0 (the townsperson) when it heads there
    return Math.abs(ox + dx * 10) < 1 ? 7 : -1
  }

  say(agent: number): boolean {
    this.said.push(agent)
    return true
  }

  setPlayers(n: number): void {
    this.players = n
  }

  folkNear(): number {
    return 3
  }
}

function setup(town: FakeTown | null) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, 1.2, 10, Vector3.Zero(), scene)
  scene.activeCamera = camera
  const views = [
    { id: 1, kind: 'player', pos: new Vector3(0, 0, 0), isDisposed: false, label: null },
    { id: 2, kind: 'player', pos: new Vector3(20, 0, 0), isDisposed: false, label: null },
    { id: 3, kind: 'player', pos: new Vector3(200, 0, 0), isDisposed: false, label: null },
    { id: 4, kind: 'mob', pos: new Vector3(1, 0, 0), isDisposed: false, label: null },
  ]
  const ctx = {
    scene,
    camera,
    world: () => (town ? { world: { town } } : null),
    views: () => views.values(),
    view: (id: number) => views.find(v => v.id === id),
    selfId: () => 1,
  } as unknown as WorldFeatureContext
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return { scene, camera, ctx }
}

describe('the town feature (TL-C)', () => {
  it('a bare context (the seam tests) does nothing', () => {
    expect(townFeature({} as never)).toEqual({})
  })

  it('a click on a townsperson: the move intent is sent first, then the townsperson answers; the click is never consumed', () => {
    const town = new FakeTown()
    const { scene, ctx } = setup(town)
    const before = townPickCount()
    const f = townFeature(ctx)
    expect(townPickCount()).toBe(before + 1)
    const sent: string[] = []
    // the world screen's pointer observer (screens/world.ts: the move intent) …
    const screenObs = scene.onPointerObservable.add(pi => {
      if (pi.type === PointerEventTypes.POINTERDOWN) sent.push('moveTo')
    })
    // … then ux-world's, which asks the town picks
    const uxObs = scene.onPointerObservable.add(pi => {
      if (pi.type === PointerEventTypes.POINTERDOWN) runTownClick(scene.pointerX, scene.pointerY)
    })
    scene.pointerX = 0
    scene.pointerY = 0
    const engine = scene.getEngine()
    const cx = engine.getRenderWidth() / 2
    const cy = engine.getRenderHeight() / 2
    // the centre of the screen looks at the townsperson (x = 0); the corner does not
    scene.pointerX = cx
    scene.pointerY = cy
    scene.onPointerObservable.notifyObservers({ type: PointerEventTypes.POINTERDOWN, event: { button: 0 } } as PointerInfo)
    expect(sent).toEqual(['moveTo'])
    expect(town.said).toEqual([7])
    expect(runTownHover(cx, cy)).toBe(true)
    expect(runTownHover(0, cy)).toBe(false)
    scene.pointerX = 0
    scene.onPointerObservable.notifyObservers({ type: PointerEventTypes.POINTERDOWN, event: { button: 0 } } as PointerInfo)
    expect(sent).toEqual(['moveTo', 'moveTo'])
    expect(town.said).toEqual([7])
    scene.onPointerObservable.remove(screenObs)
    scene.onPointerObservable.remove(uxObs)
    f.dispose?.()
    expect(townPickCount()).toBe(before)
  })

  it('the players within the crowd\'s range reach the cap (self included, mobs not)', () => {
    const town = new FakeTown()
    const { ctx } = setup(town)
    const f = townFeature(ctx)
    f.onFrame?.(0, 0.016)
    expect(town.players).toBe(2)
    f.dispose?.()
  })

  it('no town part (Classic, the stage before the world loads): nothing is asked, no bubble', () => {
    const { ctx } = setup(null)
    const f = townFeature(ctx)
    expect(() => f.onFrame?.(0, 0.016)).not.toThrow()
    expect(runTownHover(10, 10)).toBe(false)
    f.dispose?.()
  })
})
