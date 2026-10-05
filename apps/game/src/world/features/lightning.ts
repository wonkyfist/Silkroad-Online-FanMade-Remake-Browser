/**
 * Lightning that strikes, on the client (docs/WEATHER.md §2.7, §7.3b). Takes the server's `strike` messages and draws
 * them with world/lightning/fx.ts: the telegraph (a blue glow ring and static on the spot, the crackle), the bolt (a
 * fresh branching channel, flickering with its 2-4 return strokes) and what it leaves (scorch, dirt and steam, a
 * burning tree, stone chips and dust). The scene flash and the retail thunder are the weather feature's (it also takes
 * `strike`); this adds the synthesized close crack, timed by distance (~3 s per km).
 *
 * - Tier: from the weather level (Options → Graphics → Weather; settings.ts weatherLevelFor), lightning/timeline.ts
 *   TIER_FEATURES. Without the new look (weatherShown false) only the telegraph shows: it is the fair warning of a
 *   strike that can hurt, so it is never switched off.
 * - `ui.reduceFlashing`: the bolt shows dim and steady (no flicker).
 * - Debug: `window.__sroLightning` (live counts).
 */
import { SPEED_OF_SOUND, type LightningStrike } from '@sro/shared'
import type { World } from '@sro/world-render'
import type { GameAudio } from '../../audio/index.ts'
import { CRACK_MAX_M } from '../../audio/lightning.ts'
import { settings, weatherLevelFor, weatherShown, type SettingsStore } from '../../settings.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { LightningFx } from '../lightning/fx.ts'
import { tierFor, type LightningTier } from '../lightning/timeline.ts'
import { panToward, strikeFromListener } from './weather.ts'

/** A crack more than this late (a hidden tab, a stall) is skipped (ms). */
const CRACK_STALE_MS = 1500

export interface LightningFeatureOptions {
  store?: SettingsStore
}

export function lightningFeature(ctx: WorldFeatureContext, opts: LightningFeatureOptions = {}): WorldFeature {
  const store = opts.store ?? settings
  const audio: GameAudio | undefined = ctx.app?.audio
  let fx: LightningFx | null = null
  let world: World | null = null
  let tier: LightningTier | null = null
  const crackles = new Map<number, { at: number; stop(): void }>()
  const cracks: { due: number; distM: number; bearing: number }[] = []

  const listener = () => {
    const id = ctx.controlledId?.() ?? ctx.selfId()
    const v = id !== null ? ctx.view(id) : undefined
    return v?.root.position ?? ctx.camera.target
  }

  const ensure = (): LightningFx => {
    if (!fx) {
      fx = new LightningFx(ctx.scene, {
        heightAt: (x, z, y) => ctx.world()?.heightAt(x, z, y) ?? null,
        wetness: () => world?.weather.frame.wet ?? 0,
      })
      tier = null
    }
    return fx
  }

  const applyTier = () => {
    if (!fx) return
    const s = store.get()
    const next = weatherShown(s) && world ? tierFor(weatherLevelFor(s, world.render.gpu)) : 'off'
    if (next !== tier) {
      tier = next
      fx.setTier(next)
    }
    fx.setReducedFlashing(s.ui.reduceFlashing)
  }

  const stopCrackles = () => {
    for (const c of crackles.values()) c.stop()
    crackles.clear()
  }

  const onStrike = (s: LightningStrike) => {
    const f = ensure()
    applyTier()
    f.strike(s)
    audio?.lightning.prepare()
    const at = listener()
    const { distM, bearing } = strikeFromListener(s, at.x, at.y, at.z)
    const now = ctx.serverNow()
    // the telegraph's crackle, on the spot, until the bolt lands
    if (audio && s.warnAt !== undefined && s.radiusM > 0 && now < s.at && !crackles.has(s.id)) {
      const g = { x: s.pos[0], y: s.groundY ?? s.pos[1], z: s.pos[2] }
      const h = audio.lightning.crackleAt(g)
      crackles.set(s.id, { at: s.at, stop: h.stop })
    }
    if (s.kind !== 'sky' && distM <= CRACK_MAX_M) cracks.push({ due: s.at + (distM / SPEED_OF_SOUND) * 1000, distM, bearing })
  }

  const offs: Array<() => void> = [
    store.onChange(() => {
      tier = null
      applyTier()
    }),
  ]
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __sroLightning?: unknown }
    w.__sroLightning = {
      get stats() {
        return fx?.stats() ?? null
      },
      get tier() {
        return tier
      },
      /** The renderer itself (console checks: `fx.update(t, dt, cam)` then `fx.scene.render()` while the tab is hidden). */
      get fx() {
        return fx
      },
    }
    offs.push(() => {
      delete w.__sroLightning
    })
  }

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') {
        fx?.clear()
        stopCrackles()
        cracks.length = 0
      } else if (msg.t === 'strike') onStrike(msg.strike)
    },

    onFrame(now, dt) {
      const w = ctx.world()?.world ?? null
      if (w !== world) {
        world = w
        tier = null
      }
      for (const [id, c] of crackles) {
        if (now >= c.at) {
          c.stop()
          crackles.delete(id)
        }
      }
      if (audio && cracks.length) {
        const cam = ctx.camera
        for (let i = cracks.length - 1; i >= 0; i--) {
          const c = cracks[i]!
          if (c.due > now) continue
          cracks.splice(i, 1)
          if (now - c.due <= CRACK_STALE_MS && weatherShown(store.get())) audio.lightning.crackFrom(c.distM, panToward(c.bearing, cam.target.x - cam.position.x, cam.target.z - cam.position.z))
        }
      }
      if (!fx) return
      if (tier === null) applyTier()
      fx.update(now, dt, ctx.scene.activeCamera)
    },

    dispose() {
      for (const off of offs.splice(0)) off()
      stopCrackles()
      cracks.length = 0
      fx?.dispose()
      fx = null
      world = null
    },
  }
}
