/**
 * Coordinate frames of the game data export (docs/DATA.md "Coordinate frames").
 *
 *  - Client file space: region id (z << 8 | x) + region-local units (dm), x east, y up, z north.
 *  - World (manifest) frame: work/out/world/<name>/manifest.json `space`; glTF metres, x east, y up, z SOUTH,
 *    origin = south-west corner of space.originRegion. Region-local (lx, h, lz) of region (rx, rz) ->
 *    space.ts toGltfPosition(1920 (rx - ox) + lx, h, 1920 (rz - oz) + lz) = [192 (rx - ox) + 0.1 lx, 0.1 h, -(...)].
 *  - SRO game metres ("world coordinates" of the retail UI and packets): X = 192 (rx - 135) + 0.1 lx,
 *    Y (north) = 192 (rz - 92) + 0.1 lz. Only used as the bridge to the port.
 *  - Port frame (third-party port's spawns/teleporters/npcshops): derived, not assumed. `fitPortFrame` fits
 *    port = s * game + b per axis on NPCs that the port and the client npcpos.txt both place; the export requires
 *    the fit to reproduce every anchor (measured: s = 1.5, b = 0, residual < 1 mm on 33 NPCs in 5 provinces).
 *    Port heights are metres x s as well (checked against the client navmesh terrain by the exporter).
 */
import { toGltfPosition, UNIT_SCALE } from '../gltf/space.ts'

/** Region edge in file units (NVM_REGION_SIZE). */
export const REGION_UNITS = 1920
/** Region of the SRO game-coordinate origin (X = 192 (rx - 135) + lx / 10, Y = 192 (rz - 92) + lz / 10). */
export const GAME_ORIGIN_REGION = { x: 135, z: 92 } as const

export const regionId = (rx: number, rz: number) => ((rz & 0xff) << 8) | (rx & 0xff)
export const regionXZ = (id: number) => ({ rx: id & 0xff, rz: (id >> 8) & 0xff })

/** The parts of a world manifest the export needs. */
export interface WorldFrame {
  /** Manifest name, e.g. 'jangan'. */
  name: string
  originRegion: { x: number; z: number }
  /** Region ids the world converter has converted (for "inside / outside" reports). */
  regions: ReadonlySet<number>
}

/** Reads name, space.originRegion and regions[].id from a parsed manifest.json; throws on a different space. */
export function worldFrameFromManifest(m: unknown): WorldFrame {
  const o = m as { name?: unknown; space?: { metresPerUnit?: unknown; regionSizeM?: unknown; originRegion?: { x?: unknown; z?: unknown } }; regions?: Array<{ id?: unknown }> }
  const s = o?.space
  if (typeof o?.name !== 'string' || !s || typeof s.originRegion?.x !== 'number' || typeof s.originRegion?.z !== 'number') {
    throw new Error('world manifest: expected name and space.originRegion {x, z}')
  }
  if (s.metresPerUnit !== UNIT_SCALE || s.regionSizeM !== REGION_UNITS * UNIT_SCALE) {
    throw new Error(`world manifest: space ${String(s.metresPerUnit)} m/unit, ${String(s.regionSizeM)} m/region; expected 0.1 and 192`)
  }
  const regions = new Set<number>()
  for (const r of o.regions ?? []) if (typeof r.id === 'number') regions.add(r.id)
  return { name: o.name, originRegion: { x: s.originRegion.x, z: s.originRegion.z }, regions }
}

/** Global file-space position (units from the (0, 0) region's south-west corner). */
export interface FilePos {
  x: number
  y: number
  z: number
}

export function regionLocalToFile(region: number, lx: number, ly: number, lz: number): FilePos {
  const { rx, rz } = regionXZ(region)
  return { x: rx * REGION_UNITS + lx, y: ly, z: rz * REGION_UNITS + lz }
}

export function fileRegion(p: { x: number; z: number }): number {
  return regionId(Math.floor(p.x / REGION_UNITS), Math.floor(p.z / REGION_UNITS))
}

/** Global file space -> world (manifest) metres, through gltf/space.ts. */
export function fileToWorld(p: FilePos, frame: WorldFrame): { x: number; y: number; z: number } {
  const [x, y, z] = toGltfPosition([p.x - frame.originRegion.x * REGION_UNITS, p.y, p.z - frame.originRegion.z * REGION_UNITS])
  return { x, y, z: z === 0 ? 0 : z }
}

/** SRO game metres (east X, north Y, height) -> global file space. */
export function gameToFile(X: number, Y: number, h: number): FilePos {
  return { x: (X + GAME_ORIGIN_REGION.x * 192) * 10, y: h * 10, z: (Y + GAME_ORIGIN_REGION.z * 192) * 10 }
}

export function fileToGame(p: FilePos): { X: number; Y: number; h: number } {
  return { X: p.x / 10 - GAME_ORIGIN_REGION.x * 192, Y: p.z / 10 - GAME_ORIGIN_REGION.z * 192, h: p.y / 10 }
}

// ---- port frame ---------------------------------------------------------------------------------------

/** port = scale * game + offset, per horizontal axis (port z = north); port y = scale * height. */
export interface PortFrame {
  scale: number
  offsetX: number
  offsetZ: number
}

/** A position both sides place: the port record and the client's global file-space position. */
export interface FrameAnchor {
  label: string
  port: { x: number; z: number }
  file: FilePos
}

export interface PortFrameFit {
  /** Anchors offered / kept after outlier removal. */
  anchors: number
  inliers: number
  /** Anchors dropped because the port places that NPC elsewhere (residual > tolerance under the inlier fit). */
  outliers: Array<{ label: string; offM: number }>
  /** Least-squares fit per axis over the inliers (game metres -> port units). */
  fitX: { scale: number; offset: number }
  fitZ: { scale: number; offset: number }
  /** The frame the export uses: the fit rounded to 1e-3. */
  frame: PortFrame
  /** Residuals of `frame` over the inliers, metres. */
  rmsM: number
  maxM: number
  worst: string
}

function lsq(xs: number[], ys: number[]): { scale: number; offset: number } {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my)
    sxx += (xs[i]! - mx) ** 2
  }
  const scale = sxy / sxx
  return { scale, offset: my - scale * mx }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0

function residualM(a: FrameAnchor, f: PortFrame): number {
  const g = fileToGame(a.file)
  return Math.hypot(f.scale * g.X + f.offsetX - a.port.x, f.scale * g.Y + f.offsetZ - a.port.z) / f.scale
}

/**
 * Fits the port frame on anchors: least squares per axis, then the worst anchor is dropped while any is off by more
 * than `toleranceM` (the port moved a few NPCs, e.g. ferry sellers). Throws when fewer than `minAnchors` or
 * `minInlierShare` of the anchors remain, or the axes disagree on the scale.
 */
export function fitPortFrame(anchors: readonly FrameAnchor[], minAnchors = 6, toleranceM = 0.5, minInlierShare = 0.75): PortFrameFit {
  let kept = [...anchors]
  const dropped: FrameAnchor[] = []
  for (;;) {
    if (kept.length < Math.max(minAnchors, Math.ceil(anchors.length * minInlierShare))) {
      throw new Error(`port frame: only ${kept.length} of ${anchors.length} anchors agree (need ${minAnchors} and ${minInlierShare * 100} %)`)
    }
    const game = kept.map(a => fileToGame(a.file))
    const fitX = lsq(game.map(g => g.X), kept.map(a => a.port.x))
    const fitZ = lsq(game.map(g => g.Y), kept.map(a => a.port.z))
    const frame: PortFrame = { scale: round3((fitX.scale + fitZ.scale) / 2), offsetX: round3(fitX.offset), offsetZ: round3(fitZ.offset) }
    const res = kept.map(a => residualM(a, frame))
    let worstI = 0
    res.forEach((d, i) => {
      if (d > res[worstI]!) worstI = i
    })
    if (res[worstI]! > toleranceM) {
      dropped.push(kept[worstI]!)
      kept = kept.filter((_, i) => i !== worstI)
      continue
    }
    if (Math.abs(fitX.scale - fitZ.scale) > 1e-3) throw new Error(`port frame: axis scales differ (${fitX.scale} vs ${fitZ.scale})`)
    const rmsM = Math.sqrt(res.reduce((a, d) => a + d * d, 0) / res.length)
    // Outliers are reported against the final (inlier) frame.
    const outliers = dropped.map(a => ({ label: a.label, offM: round3(residualM(a, frame)) }))
    return { anchors: anchors.length, inliers: kept.length, outliers, fitX, fitZ, frame, rmsM, maxM: res[worstI]!, worst: kept[worstI]!.label }
  }
}

/** Port (x, y, z) -> global file space under a fitted frame. */
export function portToFile(p: { x: number; z: number; y?: number }, f: PortFrame): FilePos {
  return gameToFile((p.x - f.offsetX) / f.scale, (p.z - f.offsetZ) / f.scale, (p.y ?? 0) / f.scale)
}

/** Port distance (radius, sight range...) -> metres. */
export function portDistanceToMetres(d: number, f: PortFrame): number {
  return d / f.scale
}

/**
 * Port rotY -> protocol yaw (radians about +Y, 0 facing world +Z = south; the converted NPC and player glbs face
 * glTF +Z, their toe bones sit in front of the feet). The port's rotY turns a model that faces +Z in the port's
 * (x east, z north) frame (its movers use rotY = atan2(dx, dz)); mirroring north to world -Z gives yaw = pi - rotY.
 * No client table stores NPC facing. Checked against the Jangan layout (data.corpus.test.ts "turns Jangan NPCs"): the
 * four gate-soldier pairs all face into town, Storage-keeper Wangu has his storage chest behind him against the
 * fountain, and the herbalist, stable-keeper and grocer face the street with their building behind them; yaw =
 * -rotY (the other mirror) turns every one of them round, and rotY + pi/2 (a raw "0 = east" angle) spins the
 * gate soldiers into a pinwheel.
 */
export function portYawToWorld(rotY: number): number {
  let y = Math.PI - rotY
  while (y > Math.PI) y -= 2 * Math.PI
  while (y <= -Math.PI) y += 2 * Math.PI
  return y
}

/** Round to millimetres (and -0 to 0) for stable JSON. */
export const mm = (v: number) => Math.round(v * 1000) / 1000 + 0
