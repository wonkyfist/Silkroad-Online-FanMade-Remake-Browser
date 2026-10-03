import { describe, expect, it } from 'vitest'
import {
  fileRegion,
  fileToGame,
  fileToWorld,
  fitPortFrame,
  gameToFile,
  portDistanceToMetres,
  portToFile,
  portYawToWorld,
  regionLocalToFile,
  worldFrameFromManifest,
  type FrameAnchor,
  type WorldFrame,
} from '../src/data/frame.ts'

const jangan: WorldFrame = { name: 'jangan', originRegion: { x: 168, z: 97 }, regions: new Set([25000]) }

describe('world frame', () => {
  it('follows the manifest rule: region (x, z) origin = [192 (x - ox), 0, -192 (z - oz)], local (lx, h, lz) -> +0.1 (lx, h, -lz)', () => {
    // Jangan gate arrival point (teleportdata GATE_CH): region 25000 = (168, 97), local (969, 0, 1369).
    expect(fileToWorld(regionLocalToFile(25000, 969, 0, 1369), jangan)).toEqual({ x: 96.9, y: 0, z: -136.9 })
    // South-west corner of region (169, 98): [192, 0, -192]; a point 10 units north and 20 up.
    const p = fileToWorld(regionLocalToFile((98 << 8) | 169, 0, 20, 10), jangan)
    expect(p.x).toBeCloseTo(192, 9)
    expect(p.y).toBeCloseTo(2, 9)
    expect(p.z).toBeCloseTo(-193, 9)
    expect(fileRegion(regionLocalToFile(25257, 1919.9, 0, 0.1))).toBe(25257)
  })

  it('reads the frame from a manifest and rejects other units', () => {
    const m = { name: 'jangan', space: { metresPerUnit: 0.1, regionSizeM: 192, originRegion: { x: 168, z: 97, id: 25000 } }, regions: [{ id: 25000 }, { id: 25001 }] }
    const f = worldFrameFromManifest(m)
    expect(f).toMatchObject({ name: 'jangan', originRegion: { x: 168, z: 97 } })
    expect([...f.regions]).toEqual([25000, 25001])
    expect(() => worldFrameFromManifest({ ...m, space: { ...m.space, metresPerUnit: 1 } })).toThrow(/expected 0.1/)
    expect(() => worldFrameFromManifest({})).toThrow(/originRegion/)
  })

  it('converts SRO game metres (X = 192 (rx - 135) + lx / 10) both ways', () => {
    // NPC_CH_SOLDIER_EA2 in npcpos.txt: region 25001 (169, 97), local (1387.17, -0.07, 1765.02).
    const g = fileToGame(regionLocalToFile(25001, 1387.17, -0.07, 1765.02))
    expect(g.X).toBeCloseTo(6666.717, 6)
    expect(g.Y).toBeCloseTo(1136.502, 6)
    const back = gameToFile(g.X, g.Y, g.h)
    expect(back.x).toBeCloseTo(169 * 1920 + 1387.17, 6)
    expect(back.z).toBeCloseTo(97 * 1920 + 1765.02, 6)
  })
})

describe('port frame fit', () => {
  const anchorAt = (label: string, region: number, lx: number, lz: number, scale = 1.5, bx = 0, bz = 0): FrameAnchor => {
    const file = regionLocalToFile(region, lx, 0, lz)
    const g = fileToGame(file)
    return { label, port: { x: scale * g.X + bx, z: scale * g.Y + bz }, file }
  }
  const regions = [25000, 25001, 24743, 26521, 23687, 24488, 25257, 22000]
  const anchors = regions.map((r, i) => anchorAt(`npc${i}`, r, 100 + 97 * i, 1800 - 150 * i))

  it('recovers scale and offsets from exact anchors', () => {
    const fit = fitPortFrame(anchors)
    expect(fit.frame).toEqual({ scale: 1.5, offsetX: 0, offsetZ: 0 })
    expect(fit.inliers).toBe(anchors.length)
    expect(fit.maxM).toBeLessThan(1e-6)
    const shifted = fitPortFrame(regions.map((r, i) => anchorAt(`n${i}`, r, 50 * i, 70 * i, 2, 10, -4)))
    expect(shifted.frame).toEqual({ scale: 2, offsetX: 10, offsetZ: -4 })
  })

  it('drops an anchor the port moved and reports it', () => {
    const moved = [...anchors, { ...anchorAt('moved', 25000, 500, 500), port: { x: anchorAt('m', 25000, 500, 500).port.x + 30, z: anchorAt('m', 25000, 500, 500).port.z } }]
    const fit = fitPortFrame(moved)
    expect(fit.outliers).toEqual([{ label: 'moved', offM: 20 }])
    expect(fit.frame).toEqual({ scale: 1.5, offsetX: 0, offsetZ: 0 })
  })

  it('refuses too few or disagreeing anchors', () => {
    expect(() => fitPortFrame(anchors.slice(0, 3))).toThrow('only 3 of 3 anchors agree (need 6')
    const bad = anchors.map((a, i) => (i % 2 ? { ...a, port: { x: a.port.x + 100 * i, z: a.port.z } } : a))
    expect(() => fitPortFrame(bad)).toThrow(/anchors agree/)
  })

  it('maps port positions, distances and heights to world metres', () => {
    const f = { scale: 1.5, offsetX: 0, offsetZ: 0 }
    // spawns.json nest 249 (Mangnyang): port (10201.9, 3.12, 1786.93).
    const w = fileToWorld(portToFile({ x: 10201.9, y: 3.12, z: 1786.93 }, f), jangan)
    expect(w.x).toBeCloseTo(10201.9 / 1.5 - 6336, 6)
    expect(w.z).toBeCloseTo(960 - 1786.93 / 1.5, 6)
    expect(w.y).toBeCloseTo(2.08, 6)
    expect(portDistanceToMetres(75, f)).toBe(50)
  })

  it('turns port rotY into a yaw in (-pi, pi]', () => {
    expect(portYawToWorld(0)).toBeCloseTo(Math.PI, 12)
    expect(portYawToWorld(Math.PI)).toBeCloseTo(0, 12)
    expect(portYawToWorld(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12)
  })
})
