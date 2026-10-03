// H-12 hunt, lens "trees look" (WAVE_PLAN8 §6.7 item 7): the tint is wrong. The test fails on 95d49e2 and passes once
// the fix lands (F-12).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../../..')
const TREES = join(ROOT, 'work/out/world/jangan-fields/models/trees')

interface FarSidecar {
  materials: Array<{ name: string; alphaMode?: string; textureSize?: [number, number] }>
  trees?: { tints?: Array<{ name: string; materials: Record<string, { texture: string; image: string }> }> }
}

/** The pixel size a PNG declares (IHDR). */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file)
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

describe('H-12 trees look: a tint sprite drawn on cards cut for another sprite', () => {
  // make_species.py `card` sizes every leaf card from the species' role aspect (sv = su x aspect; willow03's leaf:
  // aspect 1.0, its sprite 256 x 256) and maps the whole sprite on it. A tint swaps only the image (TreeTints keeps the
  // UVs). willow03's tint 'willow01' (content/trees/species/willow03.json, the retail tre_willow01) puts
  // tre_willow01_leaf1, a 128 x 512 hanging-strand sprite, on the 1:1 leaf cards: every leaf card of that tree shows
  // the strand squeezed to a quarter of its height (4x anisotropic stretch), a smeared pale-green blob. The cut-out
  // cards (the leaves, strands, blades) of every tint must keep the role sprite's aspect (within 25 %); bark tiles by
  // metres (repeatM) and is left out.
  it.skipIf(!existsSync(TREES))('every tinted cut-out sprite keeps the aspect of the cards it is drawn on', () => {
    const bad: string[] = []
    let checked = 0
    for (const id of readdirSync(TREES)) {
      const far = join(TREES, id, 'far.json')
      if (!existsSync(far)) continue
      const side = JSON.parse(readFileSync(far, 'utf8')) as FarSidecar
      const mats = new Map(side.materials.map(m => [m.name, m]))
      for (const t of side.trees?.tints ?? []) {
        for (const [name, m] of Object.entries(t.materials)) {
          const base = mats.get(name)
          if (!base || base.alphaMode !== 'MASK' || !base.textureSize) continue
          const [bw, bh] = base.textureSize
          const [tw, th] = pngSize(join(TREES, id, m.image))
          const ratio = (th / tw) / (bh / bw)
          checked++
          if (ratio > 1.25 || ratio < 0.8) bad.push(`${id} tint ${t.name} ${name}: ${tw}x${th} on cards cut for ${bw}x${bh} (x${ratio.toFixed(2)})`)
        }
      }
    }
    expect(checked).toBeGreaterThan(30)
    expect(bad).toEqual([])
  })
})
