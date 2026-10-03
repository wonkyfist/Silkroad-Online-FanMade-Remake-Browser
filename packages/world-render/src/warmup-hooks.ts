/**
 * Warm-up hooks (W9F R1): shaders the game's graphics warm-up cannot reach by asking the scene's meshes, because they
 * are only drawn through a render target's material override that does not exist yet while it is dry (the shelter
 * map's height material, weather/shelter.ts). The owner registers a hook per scene; the warm-up
 * (apps/game/src/screens/warmup.ts) runs every hook each frame of its shader stage until all of them report ready, so
 * the first rain after a dry entry compiles nothing in play.
 */
import type { Scene } from '@babylonjs/core'

/**
 * A hook: asks its shaders (starting their compile) and answers whether they are all ready, or `'loading'` while the
 * data its meshes need is still arriving (H11-HI-1: the town's drawables on a slow link). The warm-up holds its shader
 * stage for a loading hook (up to its time cap); a hook that is only compiling is given up on with the meshes' stall.
 */
export type WarmupHook = () => boolean | 'loading'

/** All hooks ready; some compiling (none loading); or some still loading their data. */
export type WarmupHooksState = 'ready' | 'compiling' | 'loading'

const HOOKS = new WeakMap<Scene, Set<WarmupHook>>()

/** Registers `hook` for `scene`; the returned function removes it. */
export function addWarmupHook(scene: Scene, hook: WarmupHook): () => void {
  let set = HOOKS.get(scene)
  if (!set) HOOKS.set(scene, (set = new Set()))
  set.add(hook)
  return () => {
    set.delete(hook)
  }
}

/** Runs every hook of `scene` once: true when all are ready (a hook that throws counts as ready). */
export function runWarmupHooks(scene: Scene): boolean {
  return warmupHooksState(scene) === 'ready'
}

/** Runs every hook of `scene` once and answers the state of the whole set (a hook that throws counts as ready). */
export function warmupHooksState(scene: Scene): WarmupHooksState {
  let state: WarmupHooksState = 'ready'
  for (const hook of HOOKS.get(scene) ?? []) {
    try {
      const r = hook()
      if (r === 'loading') state = 'loading'
      else if (r !== true && state === 'ready') state = 'compiling'
    } catch {
      // not waited for
    }
  }
  return state
}
