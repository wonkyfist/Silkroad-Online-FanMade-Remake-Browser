/**
 * Tile atlas map planes (docs/WAVE_PLAN3.md §6.11, D39; docs/RENDER.md §6.1): the `normal` and `ormh` arrays exist only
 * when a map source is passed, share the albedo's layer per tile, are filled with a neutral layer for a tile without
 * that map, are freed and reused together, grow together (resident tiles keep their layer in every plane) and fall
 * back together.
 */
import type { BaseTexture } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { NEUTRAL_MAP, TileAtlas, type TilePlane } from '../src/tile-atlas.ts'

let serial = 0
function fakeTexture(): BaseTexture {
  const t = { id: ++serial, disposed: false, dispose() { t.disposed = true } }
  return t as unknown as BaseTexture
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0))
}

interface Upload { tex: BaseTexture; layer: number; first: number; size: number; plane: TilePlane }

function atlas(opts: { layers?: number; maps?: boolean; noMapFor?: number[]; mapSize?: number; upload?: boolean } = {}) {
  const uploads: Upload[] = []
  const created: Array<{ tex: BaseTexture; plane: TilePlane; size: number; layers: number }> = []
  const mapTex: Array<[TilePlane, BaseTexture]> = []
  const a = new TileAtlas({
    scene: null as never,
    size: 4,
    layers: opts.layers ?? 4,
    growBy: 2,
    decode: async id => new Uint8Array(4 * 4 * 4).fill(id),
    maps: opts.maps
      ? {
          normal: { decode: async id => (opts.noMapFor?.includes(id) ? null : new Uint8Array(4 * 4 * 4).fill(100 + id)) },
          ormh: { size: opts.mapSize, decode: async (id, size) => new Uint8Array(size * size * 4).fill(200 + id) },
        }
      : undefined,
    onMapTexture: (plane, tex) => mapTex.push([plane, tex]),
    create: (size, layers, plane = 'albedo') => {
      const tex = fakeTexture()
      created.push({ tex, plane, size, layers })
      return tex
    },
    upload: (tex, layer, rgba, size, plane = 'albedo') => {
      uploads.push({ tex, layer, first: rgba[0]!, size, plane })
      return opts.upload ?? true
    },
    rebuild: (layers, size) => {
      void layers
      void size
      return fakeTexture()
    },
  })
  return { a, uploads, created, mapTex }
}

describe('TileAtlas map planes', () => {
  it('without a map source only the albedo array exists (9A: no VRAM for maps, D39)', async () => {
    const { a, created, uploads } = atlas()
    await a.acquire([1, 2], () => 0)
    expect(created.map(c => c.plane)).toEqual(['albedo'])
    expect(a.mapTexture('normal')).toBeNull()
    expect(a.mapTexture('ormh')).toBeNull()
    expect(a.planeKinds).toEqual(['albedo'])
    expect(new Set(uploads.map(u => u.plane))).toEqual(new Set(['albedo']))
  })

  it('with sources: three arrays, and every tile sits at the same layer in each', async () => {
    const { a, created, uploads, mapTex } = atlas({ maps: true, mapSize: 2 })
    expect(created.map(c => [c.plane, c.size, c.layers])).toEqual([['albedo', 4, 4], ['normal', 4, 4], ['ormh', 2, 4]])
    expect(mapTex.map(m => m[0])).toEqual(['normal', 'ormh'])
    expect(a.mapTexture('normal')).toBe(created[1]!.tex)
    await a.acquire([1, 2, 3], () => 0)
    for (const id of [1, 2, 3]) {
      const layer = a.layerOf(id)!
      const at = uploads.filter(u => u.layer === layer)
      expect(at.map(u => [u.plane, u.first, u.size])).toEqual([['albedo', id, 4], ['normal', 100 + id, 4], ['ormh', 200 + id, 2]])
    }
  })

  it('a tile whose set lacks a map gets the neutral layer', async () => {
    const { a, uploads } = atlas({ maps: true, noMapFor: [7] })
    await a.acquire([7], () => 0)
    const n = uploads.find(u => u.plane === 'normal' && u.layer === a.layerOf(7))!
    expect(n.first).toBe(NEUTRAL_MAP.normal[0])
  })

  it('a released tile\'s layer is reused in every plane at once', async () => {
    const { a, uploads } = atlas({ maps: true, layers: 2 })
    await a.acquire([1, 2], () => 0)
    const l2 = a.layerOf(2)!
    a.release([2])
    uploads.length = 0
    await a.acquire([5], () => 0)
    expect(a.layerOf(5)).toBe(l2)
    expect(a.layerOf(2)).toBeUndefined()
    expect(uploads.map(u => [u.plane, u.layer, u.first])).toEqual([['albedo', l2, 5], ['normal', l2, 105], ['ormh', l2, 205]])
  })

  it('grows every plane together, keeping each resident tile at its layer', async () => {
    const { a, created, uploads, mapTex } = atlas({ maps: true, layers: 2 })
    await a.acquire([1, 2], () => 0)
    const l1 = a.layerOf(1)!, l2 = a.layerOf(2)!
    await a.acquire([3], () => 0)
    expect(a.capacity).toBe(4)
    const grown = created.slice(3)
    expect(grown.map(c => [c.plane, c.layers])).toEqual([['albedo', 4], ['normal', 4], ['ormh', 4]])
    expect(a.texture).toBe(grown[0]!.tex)
    expect(a.mapTexture('normal')).toBe(grown[1]!.tex)
    expect(mapTex.slice(-2).map(m => m[1])).toEqual([grown[1]!.tex, grown[2]!.tex])
    for (const [plane, i] of [['albedo', 0], ['normal', 1], ['ormh', 2]] as const) {
      const into = uploads.filter(u => u.tex === grown[i]!.tex).map(u => [u.layer, u.first])
      const base = plane === 'albedo' ? 0 : plane === 'normal' ? 100 : 200
      expect(into, plane).toEqual(expect.arrayContaining([[l1, base + 1], [l2, base + 2], [a.layerOf(3), base + 3]]))
    }
    // The old arrays are released with the swap.
    for (const c of created.slice(0, 3)) expect((c.tex as unknown as { disposed: boolean }).disposed).toBe(true)
  })

  it('falls back to whole-array rebuilds in every plane when single-layer uploads are refused', async () => {
    const { a } = atlas({ maps: true, upload: false })
    const before = [a.texture, a.mapTexture('normal'), a.mapTexture('ormh')]
    await a.acquire([4], () => 0)
    await settle()
    expect(a.fallback).toBe(true)
    const after = [a.texture, a.mapTexture('normal'), a.mapTexture('ormh')]
    for (let i = 0; i < 3; i++) expect(after[i]).not.toBe(before[i])
  })

  it('dispose releases every plane', async () => {
    const { a, created } = atlas({ maps: true })
    await a.acquire([1], () => 0)
    a.dispose()
    for (const c of created) expect((c.tex as unknown as { disposed: boolean }).disposed).toBe(true)
  })
})
