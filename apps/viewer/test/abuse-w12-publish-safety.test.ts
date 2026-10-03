// H-12 hunt, lens "Publish safety" (docs/WAVE_PLAN8.md §6.7 lens 2): traps, lost reachability, a probe cut off, a
// stroke past the sea mask or the bounds, the tomb keep, a uid collision, a dressing row moved by uid; Publish racing
// a convert; a partial swap on Windows (EBUSY).
// Every test here FAILS on 95d49e2 and documents one finding; F-12 makes them pass. No product code is changed here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { regionIdOf, validateWorldEditPlacements } from '../../../packages/shared/src/world-edits/index.ts'
import type { WorldPlacement } from '../../../packages/convert/src/world/manifest.ts'
import { PUBLISH_CHECKS, WORLD_EDITS_REPORT_FORMAT, WORLD_EDITS_REPORT_VERSION, type ExternalCheck, type WorldEditsReport } from '../../../packages/convert/src/world/edits/checks.ts'
import {
  keepPublish, preparePublish, publishPaths, readRecord, undoPublish, type PrepareOptions, type PublishPaths,
} from '../editor-api/publish.ts'
import { CoastGuard } from '../src/editor/terrain-edits.ts'
import { ObjectEdits, retailRef } from '../src/editor/object-edits.ts'

const WORLD = 'jangan-fields'
const tmps: string[] = []
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})
const tmp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `sro-abuse-w12-ps-${tag}-`))
  tmps.push(d)
  return d
}
const put = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const text = (file: string) => readFileSync(file, 'utf8')

// --- the Publish fixture (as editor-publish.test.ts) -------------------------------------------------------------------

const MANIFEST = (tag: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  tag, space: { originRegion: { x: 168, z: 97 } }, regions: [], tiles: [], placements: [], models: [], warnings: [], places: [],
  spawn: { x: 0, y: 0, z: 0 }, ...extra,
})
const passReport = (): WorldEditsReport => ({
  format: WORLD_EDITS_REPORT_FORMAT, version: WORLD_EDITS_REPORT_VERSION, world: WORLD, verdict: 'pass', complete: true,
  checks: PUBLISH_CHECKS.map(c => ({ id: c.id, key: c.key, title: c.title, status: 'pass' as const, summary: 'ok' })),
  nav: { regions: [], totals: { touched: 0, closed: 0, opened: 0, closedSlope: 0, closedWater: 0, objects: 0 }, problems: [] },
  swim: { deepWaterTiles: 0, deepWaterM2: 0, regions: [] }, timingsMs: {},
})
const R = (97 << 8) | 171

function fixture(): PublishPaths {
  const root = tmp('pub')
  const p = publishPaths(join(root, 'repo'), join(root, 'work'), WORLD)
  mkdirSync(p.layerDir, { recursive: true })
  put(join(p.liveDir, 'manifest.json'), MANIFEST('live'))
  put(join(p.liveDir, 'terrain', 'a.bin'), 'old A')
  put(join(p.liveDir, 'nav.bin'), 'nav')
  put(join(p.optRoot, 'slim.json'), '{"format":"sro-slim","version":1,"renamed":{}}')
  put(join(p.optRoot, 'world', WORLD, 'manifest.json'), 'opt live manifest')
  put(join(p.optRoot, 'world', WORLD, 'terrain', 'a.bin'), 'opt old A')
  put(join(p.editorDir, 'journal.ndjson'), [
    JSON.stringify({ format: 'sro-editor-journal', version: 1, world: WORLD, head: 1, folded: 0, nextId: 2, files: {} }),
    JSON.stringify({ id: 1, label: 'Raised the ground at 171,97', tool: 'raise', regions: [R] }),
  ].join('\n') + '\n')
  // a valid (empty) placements layer, so the layer folder is not empty
  put(join(p.layerDir, 'placements.json'), JSON.stringify({ format: 'sro-world-edits-placements', version: 1, world: WORLD, move: [], drop: [], add: [] }))
  return p
}

function stubs(p: PublishPaths, o: { calls?: string[]; report?: unknown; warnings?: string[]; beforeConvert?: () => void; external?: (e: Record<string, ExternalCheck>) => void } = {}): Partial<PrepareOptions> {
  let first = true
  return {
    convert: async c => {
      if (first) o.beforeConvert?.()
      first = false
      o.calls?.push(`convert ${c.edits === null ? 'base' : 'edited'}`)
      rmSync(c.stagingDir, { recursive: true, force: true })
      if (c.edits !== null) {
        put(join(c.stagingDir, 'manifest.json'), MANIFEST('edited', { ...(o.report ? { report: o.report } : {}), ...(o.warnings ? { warnings: o.warnings } : {}) }))
        put(join(c.stagingDir, 'terrain', 'a.bin'), 'new A')
        put(join(c.stagingDir, 'nav.bin'), 'nav')
        return { changed: ['manifest.json', 'terrain/a.bin'], removed: [], regions: { core: [R], ring: [], nav: [] }, drift: [], coast: 'snapshot' }
      }
      put(join(c.stagingDir, 'manifest.json'), MANIFEST('base'))
      put(join(c.stagingDir, 'terrain', 'a.bin'), 'old A')
      put(join(c.stagingDir, 'nav.bin'), 'nav')
      return { changed: ['manifest.json'], removed: [], regions: { core: [R], ring: [], nav: [] }, drift: [], coast: 'snapshot' }
    },
    optimize: async c => {
      put(join(c.outDir, 'world', WORLD, 'terrain', 'a.bin'), 'opt new A')
      return { written: [`world/${WORLD}/terrain/a.bin`], removed: [] }
    },
    runTests: async () => ({ ok: true, summary: 'ok' }),
    checks: ctx => {
      o.external?.(ctx.external)
      return passReport()
    },
  }
}

// ======================================================================================================================

describe('H-12 Publish safety: what Keep commits', () => {
  it('Keep refuses (or commits the checked layers) when the layers changed after the publish was built', async () => {
    const p = fixture()
    const ready = await preparePublish({ paths: p, ...stubs(p) })
    expect(ready.phase, ready.sentence).toBe('ready')
    // the user saves more edits (Ctrl+S is allowed while a publish is open); here the next Publish even refuses them
    put(join(p.layerDir, 'height', '171_97.png'), 'not a png')
    const refused = await preparePublish({ paths: p, ...stubs(p) })
    expect(refused.phase).toBe('stopped')
    expect(readRecord(p, ready.n)!.phase).toBe('ready') // the earlier publish stays open (by design)
    const commits: string[][] = []
    const kept = await keepPublish({ paths: p, n: ready.n, commit: paths => (commits.push(paths), 'abc1234') })
    // 95d49e2: kept, and `git commit -- content/world-edits/jangan-fields` sweeps in the layer that publish 2 just
    // refused: git ("the published states", §3.4) now holds an unchecked, unconverted, even invalid layer as published
    expect(kept.phase === 'kept' && commits.length > 0).toBe(false)
  })
})

describe('H-12 Publish safety: a failure after the swap (EBUSY / a full disk on Windows)', () => {
  it('a step failing after the live files were swapped records the publish as kept (undoable), not as "Keep did not run"', async () => {
    const p = fixture()
    const ready = await preparePublish({ paths: p, ...stubs(p) })
    // published.json cannot be written or read (simulated: a folder in its place; on Windows: held open past the
    // retries, a full disk, an antivirus lock)
    mkdirSync(join(p.editorDir, 'published.json'), { recursive: true })
    const commits: string[][] = []
    const k = await keepPublish({ paths: p, n: ready.n, commit: paths => (commits.push(paths), 'abc1234') })
    // the live map is the edited one and the content commit was made ...
    expect(text(join(p.liveDir, 'terrain', 'a.bin'))).toBe('new A')
    expect(commits.length).toBe(1)
    // ... 95d49e2: `swappedOk` is never set, so the catch calls failKeep: phase 'ready', "Keep did not run: EISDIR...".
    // Keep again refuses ("the map changed"), Go back deletes the staging but leaves the live swap, and Undo publish
    // refuses (not in published.json): the swap can only be undone by hand from publish-<n>/backup
    expect(k.phase).toBe('kept')
  })
})

describe('H-12 Publish safety: undo after a full convert', () => {
  it('Undo publish refuses when the live export was converted again since the Keep', async () => {
    const p = fixture()
    const ready = await preparePublish({ paths: p, ...stubs(p) })
    const kept = await keepPublish({ paths: p, n: ready.n, commit: () => 'abc1234' })
    expect(kept.phase, kept.sentence).toBe('kept')
    // a lane's full convert rewrites the live export (new code, new content) after the Keep
    writeFileSync(join(p.liveDir, 'manifest.json'), MANIFEST('full convert after the keep'))
    writeFileSync(join(p.liveDir, 'terrain', 'a.bin'), 'full convert A')
    put(join(p.liveDir, 'terrain', 'b.bin'), 'full convert B')
    // 95d49e2: undoPublish copies the publish's backups over the new export without checking it (keepPublish checks
    // rec.liveManifest; undo has no such check): an old manifest over new region files, a mixed export
    let undone = false
    try {
      undone = (await undoPublish(p, ready.n)).phase === 'undone'
    } catch {
      undone = false
    }
    expect(undone).toBe(false)
    expect(JSON.parse(text(join(p.liveDir, 'manifest.json'))).tag).toBe('full convert after the keep')
  })
})

describe('H-12 Publish safety: the edits pass refused an edit (uid collision, object changed under the edit)', () => {
  it("the edits pass's own problems stop the publish (check 1), never a silent skip", async () => {
    const p = fixture()
    let seen: Record<string, ExternalCheck> = {}
    const report = { edits: { problems: ['move 24744:32770: the object changed under the edit (source res\\nature\\common\\stone_field03.bsr)', 'add ed-4: no free editor uid in region 24744'] } }
    const rec = await preparePublish({ paths: p, ...stubs(p, { report, external: e => (seen = e) }) })
    expect(rec.phase).not.toBe('failed')
    // 95d49e2: placements.ts turns them into manifest warnings ("edits: ...") and skips those edits; Publish reads only
    // report.edits.baseChanged and the coast warnings, so check 1 says "1 layer file(s), all valid." and Keep ships a
    // map without the user's move (the nav step meanwhile lowers placements.json from its own `from`/`source`, so the
    // footprint moves while the model stays)
    expect(seen.layers?.status).toBe('stop')
  })

  it('a layer set the staging convert refused against the export (a warning only) stops the publish too (G-12)', async () => {
    const p = fixture()
    let seen: Record<string, ExternalCheck> = {}
    const warnings = ['world edits: 1 problem(s) in content/world-edits/jangan-fields, the layers are ignored (nothing applied): move 24744:32770: the object moved since the edit']
    const rec = await preparePublish({ paths: p, ...stubs(p, { warnings, external: e => (seen = e) }) })
    expect(rec.phase).not.toBe('failed')
    expect(seen.layers?.status).toBe('stop')
  })
})

describe('H-12 Publish safety: Publish racing a convert', () => {
  it('a publish that waited for a running convert can be kept (it was built on the export the convert left)', async () => {
    const p = fixture()
    // the full convert holding the lock finishes while Publish waits for it: the live export changes between Publish's
    // validate step (where rec.liveManifest is taken) and its staging convert (which links the new live files)
    const rec = await preparePublish({ paths: p, ...stubs(p, { beforeConvert: () => writeFileSync(join(p.liveDir, 'manifest.json'), MANIFEST('lane full convert')) }) })
    expect(rec.phase, rec.sentence).toBe('ready')
    const k = await keepPublish({ paths: p, n: rec.n, commit: () => 'abc1234' })
    // 95d49e2: refused: "the map changed since this publish was built (a convert ran). Publish again." -- every
    // publish started during a convert waits up to 30 min and then can never be kept
    expect(k.phase, k.sentence).toBe('kept')
  })
})

describe('H-12 Publish safety: a stroke past the sea mask', () => {
  it('a brush vertex inside the sea mask is clamped under the sea, whatever the ring samples saw', () => {
    // a narrow sea inlet (8 m radius) 20 m east of the brush centre; the sea level is 0 m
    const sea = { seaLevelM: 0, seaAt: (x: number, z: number) => Math.hypot(x - 20, z) < 8 }
    const g = new CoastGuard(sea)
    g.prepare(0, 0, 30) // Size 60: radius 30 m; the stamp covers the inlet
    // a Raise that would lift the inlet's floor (-2 m) to +3 m: dry land inside the sea mask
    const h = g.clamp(20, 0, -2, 3)
    // 95d49e2: prepare samples 81 points on rings of 0, 57.5, 115, 172.5 and 230 m, misses the inlet, sets
    // nearSea = false, and clamp() then returns h unchanged even for a vertex that IS in the sea mask. Publish has no
    // sea / shore / tomb-keep rule of its own (WorldEditsContext has no sea; the coast's checks run on the coast's
    // heights, before the edits), so the land in the sea ships.
    expect(h).toBeLessThanOrEqual(sea.seaLevelM - 0.5)
  })
})

describe('H-12 Publish safety: a dressing row moved by uid', () => {
  it('a box selection + Delete over the town dressing never writes a dressing uid into placements.json', () => {
    const r0 = regionIdOf(168, 97)
    const pl = (uid: number, source: string, position: [number, number, number]): WorldPlacement => ({
      objId: 7, source, models: [0], compound: false, position, rotation: [0, 0, 0, 1], yaw: 0,
      flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid, region: r0, group: 3, inConvertedRegion: true,
    })
    // a retail tree and a wave-11 dressing lamp (uid 1,000,000 + row order) side by side in the plaza
    const o = new ObjectEdits([pl(32770, 'res\\nature\\common\\tree\\tre_tree01.bsr', [150, 4, -150]), pl(1_000_007, 'res\\town\\lamp01.bsr', [152, 4, -150])], { x: 168, z: 97 }, WORLD)
    // pickRect = every object near() whose origin projects in the box (only the click path asks rowOfRef first)
    const boxed = [...o.near(151, -150, 10)].map(n => n.ref)
    for (const ref of boxed) o.set(ref, null)
    const file = o.toFile()
    // 95d49e2: the lamp is in the box, its delete is written as a retail drop of uid 1000007, and Publish stops at
    // check 1 ("not a retail uid (town dressing props are edited by row id)") with no way to find it but the raw path
    expect(validateWorldEditPlacements(file, { world: WORLD, originRegion: { x: 168, z: 97 } }).problems).toEqual([])
    expect(boxed).toContain(retailRef(r0, 32770))
  })
})
