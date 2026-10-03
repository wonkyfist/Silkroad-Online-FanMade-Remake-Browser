/**
 * WE-I (docs/WAVE_PLAN8.md §6.2; docs/WORLD_EDITOR.md §6.2 step 4, D37): `optimize-out run --files`. On a synthetic out
 * tree, the files run of the changed files on the old out-opt gives the bytes a full run of the changed tree gives, for
 * every written file (a re-coloured PNG, a new PNG named by a rewritten manifest, a changed binary, a glb, their .br),
 * removes a removed file, merges slim.json (the untouched entries byte-identical, the table sorted as the full run's),
 * works from an export folder with a prefix, and refuses an actor glb.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Document } from '@gltf-transform/core'
import { optimizeFiles } from '../src/optimize/files.ts'
import { gltfIO } from '../src/optimize/io.ts'
import { walkFiles } from '../src/optimize/measure.ts'
import { optimizeOut, type SlimManifest } from '../src/optimize/run.ts'
import { encodePng } from '../src/png.ts'

const tmp = mkdtempSync(join(tmpdir(), 'sro-wei-opt-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const put = (root: string, rel: string, bytes: Uint8Array | string) => {
  const f = join(root, ...rel.split('/'))
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, bytes)
}

/** A noisy RGBA picture (WebP ladders need texture to choose a rung). */
function picture(w: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * w * 4)
  let s = seed
  for (let i = 0; i < out.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const v = (i / 4) % w
    out[i] = (v * 3 + (s & 31)) & 255
    out[i + 1] = ((i >> 6) + (s >> 8)) & 255
    out[i + 2] = (seed * 40 + (s >> 16)) & 255
    out[i + 3] = 255
  }
  return out
}

/** A small static mesh glb (a quad), shifted by `dx`. */
async function quadGlb(dx: number): Promise<Uint8Array> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const pos = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx + 1, 0, 1, dx, 0, 1]))
  const nrm = doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]))
  const uv = doc.createAccessor().setType('VEC2').setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]))
  const idx = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
  const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setAttribute('TEXCOORD_0', uv).setIndices(idx)
  const mesh = doc.createMesh('quad').addPrimitive(prim)
  doc.createScene().addChild(doc.createNode('quad').setMesh(mesh))
  return (await gltfIO()).writeBinary(doc)
}

const manifest = (minimaps: string[]) => JSON.stringify({
  name: 'w', regions: [{ id: 1, lightmap: { file: 'terrain/1_1_lightmap.png' }, minimap: minimaps[0] ?? null }],
  extra: minimaps.slice(1), note: 'x'.repeat(2000),
}, null, 1) + '\n'

/** The "before" tree: a world export and a sky image (an entry outside the export, kept by the merge). */
async function before(root: string): Promise<void> {
  put(root, 'world/w/terrain/1_1_lightmap.png', encodePng(32, 32, picture(32, 1)))
  put(root, 'world/w/minimap/1x1.png', encodePng(32, 32, picture(32, 2)))
  put(root, 'world/w/terrain/1_1.bin', new Uint8Array(3000).fill(7))
  put(root, 'world/w/terrain/2_1.bin', new Uint8Array(500).fill(9))
  put(root, 'world/w/models/quad.glb', await quadGlb(0))
  put(root, 'world/w/manifest.json', manifest(['minimap/1x1.png']))
  put(root, 'sky/cloud1.png', encodePng(16, 16, picture(16, 3)))
}

/** The edit: a re-coloured lightmap, a new minimap named by the manifest, a changed binary and glb, a removed binary. */
const CHANGED = ['world/w/terrain/1_1_lightmap.png', 'world/w/minimap/2x1.png', 'world/w/manifest.json', 'world/w/terrain/1_1.bin',
  'world/w/models/quad.glb', 'world/w/terrain/2_1.bin']
async function edit(root: string): Promise<void> {
  put(root, 'world/w/terrain/1_1_lightmap.png', encodePng(32, 32, picture(32, 4)))
  put(root, 'world/w/minimap/2x1.png', encodePng(32, 32, picture(32, 5)))
  put(root, 'world/w/manifest.json', manifest(['minimap/1x1.png', 'minimap/2x1.png']))
  put(root, 'world/w/terrain/1_1.bin', new Uint8Array(3000).fill(8))
  put(root, 'world/w/models/quad.glb', await quadGlb(2))
  rmSync(join(root, 'world', 'w', 'terrain', '2_1.bin'))
}

describe('optimize-out run --files (WE-I)', () => {
  it('equals the full run for the changed files, removes the removed one and merges slim.json', async () => {
    const src = join(tmp, 'out')
    await before(src)
    const live = join(tmp, 'out-opt')
    await optimizeOut({ inDir: src, outDir: live, noCensus: true, precompress: true })
    const slimBefore = JSON.parse(readFileSync(join(live, 'slim.json'), 'utf8')) as SlimManifest
    expect(existsSync(join(live, 'world', 'w', 'terrain', '2_1.bin'))).toBe(true)

    await edit(src)
    const full = join(tmp, 'full-opt')
    await optimizeOut({ inDir: src, outDir: full, noCensus: true, precompress: true })
    const r = await optimizeFiles({ inDir: src, outDir: live, files: CHANGED, precompress: true })

    // every file the files run wrote equals the full run's
    for (const f of r.written.filter(f => f !== 'slim.json' && f !== 'slim.json.br')) {
      expect(readFileSync(join(live, ...f.split('/'))).equals(readFileSync(join(full, ...f.split('/')))), f).toBe(true)
    }
    expect(r.written).toEqual(expect.arrayContaining([
      'world/w/terrain/1_1_lightmap.webp', 'world/w/minimap/2x1.webp', 'world/w/manifest.json', 'world/w/terrain/1_1.bin',
      'world/w/models/quad.glb', 'slim.json',
    ]))
    // and the whole out-opt now equals the full run's (slim-report.json is the full run's own; generatedAt aside)
    const files = walkFiles(full).filter(f => f !== 'slim-report.json' && f !== 'slim.json' && f !== 'slim.json.br')
    expect(walkFiles(live).filter(f => f !== 'slim-report.json' && f !== 'slim.json' && f !== 'slim.json.br')).toEqual(files)
    for (const f of files) expect(readFileSync(join(live, f)).equals(readFileSync(join(full, f))), f).toBe(true)

    // the removed binary is gone (with its .br when it had one)
    expect(r.removed).toContain('world/w/terrain/2_1.bin')
    expect(existsSync(join(live, 'world', 'w', 'terrain', '2_1.bin'))).toBe(false)

    // slim.json: the full run's table, the untouched entries byte-identical
    const merged = JSON.parse(readFileSync(join(live, 'slim.json'), 'utf8')) as SlimManifest
    const fresh = JSON.parse(readFileSync(join(full, 'slim.json'), 'utf8')) as SlimManifest
    expect(JSON.stringify(merged.renamed)).toBe(JSON.stringify(fresh.renamed))
    for (const [k, v] of Object.entries(slimBefore.renamed)) expect(merged.renamed[k]).toBe(v)
    expect(merged.renamed['world/w/minimap/2x1.png']).toBe('world/w/minimap/2x1.webp')
    expect({ ...merged, generatedAt: '' }).toEqual({ ...fresh, generatedAt: '' })
    expect(r.slimChanged).toBe(true)
  }, 120_000)

  it('runs from an export folder with a prefix, keeps slim.json when no rename changes, refuses actor glbs', async () => {
    const src = join(tmp, 'out2')
    await before(src)
    const live = join(tmp, 'out-opt2')
    await optimizeOut({ inDir: src, outDir: live, noCensus: true })
    const viaRoot = join(tmp, 'via-root')
    cpSync(live, viaRoot, { recursive: true })
    const slimText = readFileSync(join(live, 'slim.json'), 'utf8')

    // a re-coloured lightmap only: no rename changes, so slim.json stays byte-identical (generatedAt kept)
    put(src, 'world/w/terrain/1_1_lightmap.png', encodePng(32, 32, picture(32, 9)))
    const a = await optimizeFiles({ inDir: join(src, 'world', 'w'), prefix: 'world/w/', outDir: live, files: ['terrain/1_1_lightmap.png'] })
    const b = await optimizeFiles({ inDir: src, outDir: viaRoot, files: ['world/w/terrain/1_1_lightmap.png'] })
    expect(a.written).toEqual(['world/w/terrain/1_1_lightmap.webp'])
    expect(b.written).toEqual(a.written)
    expect(readFileSync(join(live, 'world', 'w', 'terrain', '1_1_lightmap.webp')).equals(readFileSync(join(viaRoot, 'world', 'w', 'terrain', '1_1_lightmap.webp')))).toBe(true)
    expect(a.slimChanged).toBe(false)
    expect(readFileSync(join(live, 'slim.json'), 'utf8')).toBe(slimText)

    // a staging out-opt: written beside, merged from the live slim.json
    const stage = join(tmp, 'stage-opt')
    const c = await optimizeFiles({ inDir: src, outDir: stage, files: ['world/w/terrain/1_1_lightmap.png'], slimFrom: join(live, 'slim.json') })
    expect(c.written).toEqual(['slim.json', 'world/w/terrain/1_1_lightmap.webp'])
    expect(readFileSync(join(stage, 'slim.json'), 'utf8')).toBe(slimText)

    put(src, 'char/x/hero.glb', await quadGlb(0))
    await expect(optimizeFiles({ inDir: src, outDir: live, files: ['char/x/hero.glb'] })).rejects.toThrow(/actor glb/)
    await expect(optimizeFiles({ inDir: src, outDir: join(tmp, 'nowhere'), files: [] })).rejects.toThrow(/no slim.json/)
    await expect(optimizeFiles({ inDir: src, outDir: live, files: [], prefix: 'world/w' })).rejects.toThrow(/must end with/)
  }, 120_000)
})
