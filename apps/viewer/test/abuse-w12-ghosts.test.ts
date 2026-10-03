// H-12 lens "ghosts" (docs/WAVE_PLAN8.md §6.7 item 4; docs/WORLD_EDITOR.md §4.6 "Baked shadows follow", §9 cut 8,
// WAVE_PLAN8 §7 cut 14): a move, delete or add in the editor must re-bake the lightmap of the regions its old and new
// shadows touch ("the editor in a worker, the converter at Publish"), so no ghost shadow stays behind in the editor's
// view. Cut 14 (the editor's live lightmap preview) was not taken (I-12: "no §7 cut needed"), yet no editor module runs
// the bake: after deleting a tree or moving a building, the editor keeps the old baked shadow (Low, and Medium beyond
// the 60 m CSM range, High beyond 150 m) and a planted tree has none until Publish.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const EDITOR_SRC = fileURLToPath(new URL('../src/editor', import.meta.url))

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.ts$/.test(name)) out.push(p)
  }
  return out
}

describe('ghost shadows in the editor', () => {
  it('an object edit re-bakes the touched regions\' lightmaps in the editor (the converter\'s node-free bake)', () => {
    const baking = sources(EDITOR_SRC).filter(f => /\bbakeEditedLightmap\b/.test(readFileSync(f, 'utf8')))
    expect(baking.map(f => f.slice(EDITOR_SRC.length + 1))).not.toEqual([])
  })
})
