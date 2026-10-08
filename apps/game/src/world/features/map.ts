/**
 * World feature of lane FLD-C, fields integration and the world map (docs/FIELDS.md; WAVE_PLAN §4.12). Only that lane
 * edits this file. It wires:
 * - the world map window (world/map/worldmap.ts): key M (hud.keys), Esc closes it, `hud.openWorldMap` for the
 *   minimap's map button (decision 22); zone labels, hunting clusters and NPC markers are built the first time it opens,
 *   leaving out what stands in the open sea (the coast field's sea mask: the drowned Western China side's nests,
 *   docs/COAST.md §4.1);
 * - the zone table for UX-B's area label (world/map/zones.ts zoneAt), loaded at once;
 * - region streaming: `world.setFocus` on worldEnter and on a warp of the own character, so the streamer re-centres at
 *   once instead of on the next frame; and the streaming stats line under UX-A's performance line (Options → Show FPS).
 */
import { DEFAULT_LEVEL_CAP, contentEntries, type NestDef, type ServerMessage } from '@sro/shared'
import type { StreamStats } from '@sro/world-render'
import { t } from '../../i18n/index.ts'
import { settings } from '../../settings.ts'
import type { WorldFeatureFactory } from '../features.ts'
import { huntingClusters, type HuntCluster, type HuntNest } from '../map/hunting.ts'
import { MapTransform, WorldMapWindow, mapFill, mapGeometry, type MapManifest, type MapMarker } from '../map/worldmap.ts'
import { loadZones, setZoneOrigin, zoneIndex } from '../map/zones.ts'

/** Nests with mobs above cap + this stay empty on the server (config MOB_LEVEL_MAX default: LEVEL_CAP + 5). */
export const NEST_LEVEL_MARGIN = 5
export const NESTS_URL = '/out/data/nests.json'
const STATS_EVERY_S = 0.5

/** The streaming line for the performance overlay: regions ready/wanted, MB downloaded, frame costs. */
export function streamStatsText(s: Pick<StreamStats, 'ready' | 'wanted' | 'bytes' | 'lastFrameMs' | 'worstFrameMs'>): string {
  return t('map.streamStats', {
    ready: s.ready,
    wanted: s.wanted,
    mb: (s.bytes / 1048576).toFixed(1),
    last: s.lastFrameMs.toFixed(1),
    worst: s.worstFrameMs.toFixed(1),
  })
}

/** NPC marker kind from its services. */
export function markerKind(npc: { shop?: string; roles?: string[] }): MapMarker['kind'] {
  const roles = npc.roles ?? []
  if (roles.includes('teleport')) return 'teleport'
  if (roles.includes('storage')) return 'storage'
  if (npc.shop || roles.includes('shop')) return 'shop'
  return 'npc'
}

const STATS_CSS = `
.fld-stream-stats { position: absolute; left: 236px; top: 32px; padding: 2px 8px; border-radius: 3px;
  background: rgba(0, 0, 0, 0.55); color: #cfe3ff; font: 11px var(--font-body); white-space: nowrap; pointer-events: none; z-index: 2; }
.fld-stream-stats[hidden] { display: none; }
`

export const mapFeature: WorldFeatureFactory = ctx => {
  const { app, hud, keys } = ctx
  const offs: (() => void)[] = []
  let win: WorldMapWindow | null = null
  let levelCap = DEFAULT_LEVEL_CAP
  let hunting: HuntCluster[] = []
  let huntingStarted = false
  let nests: HuntNest[] | null = null
  /** Whether `hunting` was built with the coast field (the sea filter); rebuilt once when the field arrives later. */
  let huntingSea = false
  let markers: MapMarker[] | null = null
  let wired = false

  void loadZones()

  const self = () => {
    const id = ctx.controlledId?.() ?? ctx.selfId() // Play the Boss: the steered mob while piloting
    const v = id === null ? undefined : ctx.view(id)
    if (!v) return null
    return { x: v.pos.x, z: v.pos.z, yaw: v.yaw, level: hud.stats?.level ?? v.state.level ?? 1 }
  }

  /** The coast's open sea at glTF (x, z) (false without a coast field). */
  const inSea = (x: number, z: number) => ctx.world()?.world.coast?.seaAt(x, z) ?? false

  const buildHunting = (transform: MapTransform) => {
    if (!nests) return
    const mobs = app.catalog.content.mobs
    huntingSea = !!ctx.world()?.world.coast
    hunting = huntingClusters(nests.filter(n => !inSea(n.x, n.z)), code => mobs.get(code), { bounds: transform.bounds, maxLevel: levelCap + NEST_LEVEL_MARGIN })
  }

  const loadHunting = (transform: MapTransform) => {
    if (huntingStarted) return
    huntingStarted = true
    void fetch(NESTS_URL, { cache: 'no-cache' })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        nests = contentEntries<NestDef>(await res.json(), 'nests') as HuntNest[]
        buildHunting(transform)
        win?.draw()
      })
      .catch(err => console.warn('[map] nests.json unavailable; no hunting labels', err))
  }

  const npcMarkers = (transform: MapTransform): MapMarker[] => {
    const b = transform.bounds
    const out: MapMarker[] = []
    for (const n of app.catalog.content.npcs.values()) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.z) || n.x < b.minX || n.x > b.maxX || n.z < b.minZ || n.z > b.maxZ) continue
      if (inSea(n.x, n.z)) continue
      out.push({ x: n.x, z: n.z, name: n.name ?? n.code, kind: markerKind(n) })
    }
    return out
  }

  /** The window, built the first time it opens (needs the loaded world's manifest). */
  const mapWindow = (): WorldMapWindow | null => {
    if (win) return win
    const g = ctx.world()
    if (!g) return null
    const manifest = g.world.manifest as unknown as MapManifest
    const origin = manifest.space?.originRegion ?? { x: 168, z: 97 }
    setZoneOrigin(origin)
    const geo = mapGeometry(manifest)
    const transform = new MapTransform(geo, origin)
    const assets = g.world.assets
    const tiles = geo.file
      ? []
      : manifest.regions.flatMap(r => (r.minimap ? [{ rx: r.x, rz: r.z, url: assets.url(r.minimap) }] : []))
    markers = npcMarkers(transform)
    win = new WorldMapWindow(app.art, hud.layer, {
      transform,
      imageUrl: geo.file ? assets.url(geo.file) : null,
      tiles,
      fill: mapFill(manifest),
      self,
      zones: zoneIndex,
      hunting: () => {
        if (nests && !huntingSea && ctx.world()?.world.coast) buildHunting(transform)
        return hunting
      },
      markers: () => markers ?? [],
    })
    loadHunting(transform)
    return win
  }

  const toggle = () => {
    const w = mapWindow()
    if (!w) return
    w.toggle()
  }

  offs.push(keys.register({ id: 'window.map', keys: ['m'], label: 'keys.window.map', group: 'windows', when: () => !!ctx.world(), run: () => toggle() }))

  // The streaming line under UX-A's performance line (same visibility: Options → Show FPS).
  let statsEl: HTMLElement | null = null
  let statsT = 0
  const statsLine = (): HTMLElement => {
    if (statsEl) return statsEl
    if (!document.querySelector('style[data-owner="fld-stream"]')) {
      const style = document.createElement('style')
      style.dataset.owner = 'fld-stream'
      style.textContent = STATS_CSS
      document.head.append(style)
    }
    statsEl = document.createElement('div')
    statsEl.className = 'fld-stream-stats'
    statsEl.hidden = true
    hud.layer.append(statsEl)
    return statsEl
  }

  const focusOn = (x: number, z: number) => {
    const g = ctx.world()
    if (g?.world.stream && Number.isFinite(x) && Number.isFinite(z)) g.world.setFocus(x, z)
  }

  return {
    onMessage(msg: ServerMessage) {
      if (msg.t === 'worldEnter') {
        levelCap = msg.world.levelCap ?? DEFAULT_LEVEL_CAP
        focusOn(msg.self.pos[0], msg.self.pos[2])
      } else if (msg.t === 'warp' && msg.id === ctx.selfId()) {
        focusOn(msg.pos[0], msg.pos[2])
      }
    },

    onFrame(_now, dt) {
      const g = ctx.world()
      if (g && !wired) {
        wired = true
        const origin = g.world.manifest.space?.originRegion
        if (origin) setZoneOrigin(origin)
        hud.openWorldMap = () => {
          const w = mapWindow()
          if (w && !w.isOpen) w.open()
          else w?.raise()
        }
      }
      statsT -= dt
      if (statsT > 0) return
      statsT = STATS_EVERY_S
      const stream = g?.world.stream
      const show = !!stream && settings.get().ui.showFps
      if (!show) {
        if (statsEl) statsEl.hidden = true
        return
      }
      const line = statsLine()
      line.hidden = false
      line.textContent = streamStatsText(stream.stats)
    },

    escape() {
      if (!win?.isOpen) return false
      win.close()
      return true
    },

    dispose() {
      for (const off of offs.splice(0)) off()
      if (hud.openWorldMap) hud.openWorldMap = undefined
      win?.dispose()
      win = null
      statsEl?.remove()
      statsEl = null
    },
  }
}
