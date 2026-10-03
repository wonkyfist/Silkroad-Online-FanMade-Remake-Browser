/**
 * H-10R adversarial hunt, lens "leaks", world-render's side (docs/BATCHING.md §3.13: "reference counts and a grace
 * time"; WAVE_PLAN6 §6.1 BT-A). Every test states the lifetime rule the code claims in its own comments and shows where
 * it does not hold. NullEngine only; no product code is changed by this file.
 *
 * 1. (render) AtlasArrays.reupload (batch/atlas.ts: after an array growth whose GPU copy failed, every resident cell
 *    of that array decodes and uploads again) puts a READY cell back into 'uploading'. A region that unloads in that
 *    window releases the cell's last claim while it is 'uploading'; releaseEntry then leaves it for "it becomes unused
 *    when it is ready (decoded / upload's `then`)", but the re-upload's `then` only sets 'ready' and never marks it
 *    unused (decoded()'s `then` does). The cell is neither used nor in the unused set: never evicted, its block never
 *    freed, for the rest of the world. The atlas then grows (and spills) instead of reusing the space.
 *    copyArrayLayers returns false when the engine cannot copy (WebGL2: no read framebuffer / bind internals, or a
 *    throw; WebGPU: no device or resource), the case this path exists for.
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtlasArrays, cellShape, inlineCellDecoder, type CellJob } from '../src/batch/atlas.ts'
import type { CellDecoders } from '../src/pbr/decode-core.ts'

vi.mock('../src/textures.ts', async orig => ({ ...(await orig<typeof import('../src/textures.ts')>()), copyArrayLayers: () => false }))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function nullScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

const noImages: CellDecoders = {
  url: async url => { throw new Error(`404 ${url}`) },
  bytes: async () => { throw new Error('undecodable bytes') },
}

const solid = (key: string, size = 64) => ({
  key,
  shape: cellShape(size, size, size, 1),
  job: (shape: ReturnType<typeof cellShape> | null): CellJob => ({ kind: 'cell-albedo', shape, page: size, levels: 1, image: { kind: 'solid', rgba: [1, 2, 3, 255] }, alpha: 'none' }),
})

const ticks = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

describe('the batch atlas: a cell released during its re-upload', () => {
  it('is evicted after the grace time like any other unused cell', async () => {
    let now = 0
    const jobs: Array<() => void> = []
    const flush = () => {
      while (jobs.length) jobs.shift()!()
    }
    const atlas = new AtlasArrays(nullScene(), {
      name: 't', page: 64, levels: 1, maxLayers: 8, firstLayers: 1, graceS: 1, now: () => now,
      job: run => jobs.push(run), decoder: inlineCellDecoder(noImages),
    })
    // A cell fills layer 0 of the one-layer array.
    const a = atlas.acquire(solid('a'))
    await ticks()
    flush()
    await a.ready
    // The next cell grows the array; the GPU copy fails, so A decodes and uploads again ('uploading').
    const b = atlas.acquire(solid('b'))
    expect(atlas.stats.reuploads).toBe(1)
    await ticks()
    // A's region unloads meanwhile: its last claim goes.
    a.release()
    flush()
    await ticks()
    flush()
    await b.ready
    b.release()
    expect(atlas.refs('a')).toBe(0)
    expect(atlas.refs('b')).toBe(0)
    // Past the grace time every unused cell is evicted (BATCHING §3.13): nothing stays resident.
    now = 60_000
    atlas.update(now)
    expect({ cells: atlas.cells, unused: atlas.unusedCells }).toEqual({ cells: 0, unused: 0 })
  })
})
