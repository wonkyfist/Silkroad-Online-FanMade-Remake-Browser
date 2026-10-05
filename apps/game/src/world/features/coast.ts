/**
 * World feature of lane CST-A (docs/COAST.md §10, §12.6; docs/WAVE_PLAN6.md lane CST-A): the coast's life and sound
 * on the world screen.
 *
 * - **The `COAST` area and the surf** (audio/coast.ts): within 120 m of the sea (out again beyond 140 m) the
 *   ambience becomes `COAST`, unless the player is in town (the town wins); up to 4 positional surf voices at the
 *   nearest shore points, with the storm surf from the sea's Hs. This runs after the sound feature (SND-C), so its
 *   town/field choice on a town change is corrected here when on the coast.
 * - **The gulls** (world/fx/critters.ts): registered on `World.life` once the coast field has loaded, and again on
 *   every new life part (a preset switch makes one); none on the Classic path (no life part).
 * - **The ships** (world/fx/ships.ts): on the PBR presets only (`World.render.mode`), disposed on the Classic path.
 * Everything degrades to nothing without a coast field (an older export) or without sound.
 */
import { SroOcean, oceanWaveQuery, type LifePart, type World } from '@sro/world-render'
import { COAST_AREA, CoastAudio } from '../../audio/coast.ts'
import type { WorldFeatureContext, WorldFeatureFactory } from '../features.ts'
import { loadCoastSea, registerGulls, type CoastSea } from '../fx/critters.ts'
import { CoastShips } from '../fx/ships.ts'

export const coastFeature: WorldFeatureFactory = (ctx: WorldFeatureContext) => {
  const audio = ctx.app?.audio ?? null
  const surf = audio ? new CoastAudio({ loopAt: (file, o) => audio.loopAt(file, o) }) : null
  let inTown = false
  let world: World | null = null
  let sea: CoastSea | null = null
  let seaPending = false
  let life: LifePart | null = null
  let offGulls: (() => void) | null = null
  let ships: CoastShips | null = null
  let coastArea = false

  const dropShips = () => {
    ships?.dispose()
    ships = null
  }
  const dropGulls = () => {
    offGulls?.()
    offGulls = null
    life = null
  }
  const leaveWorld = () => {
    dropGulls()
    dropShips()
    sea = null
    seaPending = false
  }
  const setCoastArea = (on: boolean) => {
    if (on === coastArea) return
    coastArea = on
    audio?.setArea(on ? COAST_AREA : inTown ? 'JANGAN_TOWN' : 'JANGAN_FIELD')
  }

  /** Follows the world, its ocean's field and its life part. */
  const follow = (w: World | null) => {
    if (w !== world) {
      leaveWorld()
      world = w
    }
    if (!w) return
    if (!sea && !seaPending && w.ocean instanceof SroOcean) {
      seaPending = true
      void loadCoastSea(w).then(
        s => {
          if (world !== w) return
          sea = s
        },
        () => {},
      )
    }
    if (!sea) return
    if (w.life !== life) {
      dropGulls()
      life = w.life
      if (life) offGulls = registerGulls(life, sea, (x, z) => w.heightAt(x, z))
    }
    const pbr = w.render.mode === 'pbr'
    if (pbr && !ships) ships = new CoastShips(ctx.scene, sea, oceanWaveQuery(w.ocean))
    else if (!pbr && ships) dropShips()
  }

  // The console's view (`window.__sroCoast`): the area, the surf, the ships and the gulls, for the hunt and the look.
  const debug = {
    get inZone() {
      return surf?.inZone ?? false
    },
    get distanceM() {
      return surf?.distanceM ?? Infinity
    },
    get emitters() {
      return surf?.emitterPositions().map(p => ({ ...p })) ?? []
    },
    get voices() {
      return surf?.voices ?? 0
    },
    get ships() {
      return ships?.routes().map(r => ({ ...r })) ?? []
    },
    get gulls() {
      return !!offGulls
    },
    get sea() {
      return !!sea
    },
    get area() {
      return audio?.ambient.area ?? null
    },
    /** The scene and the world, for console probes. */
    get scene() {
      return ctx.scene
    },
    get world() {
      return world
    },
  }
  if (typeof window !== 'undefined') (window as unknown as { __sroCoast?: unknown }).__sroCoast = debug

  return {
    onFrame(_now, dt) {
      const w = ctx.world()?.world ?? null
      try {
        follow(w)
      } catch (err) {
        console.warn('[coast] follow failed', err)
      }
      const selfId = ctx.controlledId?.() ?? ctx.selfId() // Play the Boss: the steered mob while piloting
      const self = selfId !== null ? ctx.view(selfId) : undefined
      if (!self) return
      const p = self.root.position
      ships?.update(p.x, p.z, dt, ctx.scene.fogEnd)
      if (surf) {
        const hs = w?.ocean instanceof SroOcean ? w.ocean.stats.hs : 0
        surf.update({ x: p.x, y: p.y, z: p.z, sea: sea ?? w?.coast ?? null, hs, dt })
        setCoastArea(surf.inZone && !inTown)
      }
    },

    onTownChange(town) {
      inTown = town
      // The sound feature has just set the town or field ambience: keep the coast's while on the coast.
      if (coastArea && !town) audio?.setArea(COAST_AREA)
      else if (coastArea) coastArea = false
    },

    dispose() {
      if (typeof window !== 'undefined') {
        const w = window as unknown as { __sroCoast?: unknown }
        if (w.__sroCoast === debug) delete w.__sroCoast
      }
      leaveWorld()
      world = null
      surf?.stop()
      coastArea = false
    },
  }
}
