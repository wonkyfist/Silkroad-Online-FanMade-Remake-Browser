/**
 * H-12 lens 5, "incremental drift" (docs/WAVE_PLAN8.md §6.7): a second Publish on the first's output.
 *
 * The first Publish of a layer set with a sound zone and a grass mask puts `sound-zones.json` and `grass/<x>_<z>.png`
 * into the live export. The next incremental convert (WE-I, convert-region.ts) hard-links every live file into the
 * staging export (Staging.init), then:
 * - the edits pass writes `sound-zones.json` with writeFileSync through that link (edits/index.ts `pass`): the LIVE
 *   file is rewritten in place before any check or swap, and Staging.finish then throws ("live file(s) changed while
 *   hard-linked"), so every Publish after the first one that kept a zone fails, with the live map already edited;
 * - a layer set without zones or grass (a revert) removes the staging links (rmSync / unlink), and Staging.finish links
 *   every live file it "did not write or remove" back in: the staging export keeps `sound-zones.json` and the grass
 *   mask, `removed` is empty, so the Publish swap never deletes them from the live export (the game fetches
 *   sound-zones.json unconditionally: deleted zones keep playing), and incremental != full (G7).
 *
 * On the retail archives (skips without sro.config.json), a small streamed world, as convert-region.test.ts.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyGrassLayer, encodeGrassLayer } from '../../shared/src/world-edits/index.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { comparableManifest, convertRegions, listFiles } from '../src/tools/convert-region.ts'
import { convertWorld, regionRange, type WorldPreset } from '../src/world/convert-world.ts'
import { grassMaskFile, SOUND_ZONES_FILE } from '../src/world/edits/layers.ts'
import type { WorldManifest } from '../src/world/manifest.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const tmp = mkdtempSync(join(tmpdir(), 'sro-h12-inc-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const zone = (id: string, x: number) => ({ id, name: id, shape: { circle: { x, z: -50, r: 20 } }, sound: 'amb_water', gainDb: -6, fadeM: 10, when: 'always' })

/** A layer folder: optional zones and an optional grass mask in region (rx, rz); palette.json always (as shipped). */
async function layers(dir: string, opts: { zones?: object[]; grass?: { x: number; z: number } }): Promise<string> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'palette.json'), '[]')
  if (opts.zones) writeFileSync(join(dir, 'zones.json'), JSON.stringify(opts.zones, null, 1))
  if (opts.grass) {
    mkdirSync(join(dir, 'grass'), { recursive: true })
    const g = emptyGrassLayer()
    for (let i = 0; i < 400; i++) {
      g.mask[i] = 1
      g.density[i] = 40
    }
    await sharp(Buffer.from(encodeGrassLayer(g)), { raw: { width: 192, height: 192, channels: 4 } }).png()
      .toFile(join(dir, 'grass', `${opts.grass.x}_${opts.grass.z}.png`))
  }
  return dir
}

/** Every file of `b` equals `a`'s (the manifest by G7's comparison); returns the differences. */
function differences(a: string, b: string): string[] {
  const out: string[] = []
  const fa = listFiles(a)
  const fb = listFiles(b)
  const onlyA = fa.filter(f => !fb.includes(f))
  const onlyB = fb.filter(f => !fa.includes(f))
  if (onlyA.length || onlyB.length) out.push(`file lists differ: only full [${onlyA.join(', ')}], only incremental [${onlyB.join(', ')}]`)
  for (const f of fa) {
    if (!fb.includes(f) || f === 'manifest.json') continue
    if (!readFileSync(join(a, f)).equals(readFileSync(join(b, f)))) out.push(f)
  }
  const ma = comparableManifest(JSON.parse(readFileSync(join(a, 'manifest.json'), 'utf8')) as WorldManifest)
  const mb = comparableManifest(JSON.parse(readFileSync(join(b, 'manifest.json'), 'utf8')) as WorldManifest)
  if (JSON.stringify(ma, null, 1) !== JSON.stringify(mb, null, 1)) out.push('manifest.json')
  return out
}

describe.skipIf(!hasConfig)('H-12 incremental: a second Publish on the first one\'s output (sound zones, grass masks)', () => {
  const name = 'h12-inc'
  const preset: WorldPreset = { x0: 171, x1: 172, z0: 98, z1: 99, centre: { x: 171, z: 98 }, stream: true }
  const full = {
    name, regions: regionRange(preset.x0, preset.x1, preset.z0, preset.z1), origin: preset.centre, objects: true, navmesh: true, validate: false,
    stream: true, log: () => {},
  }
  const prePassCache = join(tmp, 'cache', 'prepass.json')
  const base = { world: name, preset, prePassCache, snapshot: null, record: null, log: () => {} }
  const published = join(tmp, 'published')
  const grassRel = grassMaskFile(171, 98)

  beforeAll(async () => {
    // "the first Publish": the live export carries a zone and a grass mask (a full convert with the layers gives the
    // incremental's bytes, G7)
    const first = await layers(join(tmp, 'layers-1'), { zones: [zone('z1', 50)], grass: { x: 171, z: 98 } })
    await convertWorld({ ...full, outDir: published, prePassCache, edits: first })
    // the unedited export, what a revert must give back
    await convertWorld({ ...full, outDir: join(tmp, 'plain') })
  }, 300_000)

  it('the fixture: the published export has the zone file and the grass mask', () => {
    expect(existsSync(join(published, SOUND_ZONES_FILE))).toBe(true)
    expect(existsSync(join(published, ...grassRel.split('/')))).toBe(true)
    expect(existsSync(join(tmp, 'plain', SOUND_ZONES_FILE))).toBe(false)
  })

  it('a second Publish that changes a zone neither rewrites the live file nor fails', async () => {
    const live = join(tmp, 'live-a')
    cpSync(published, live, { recursive: true })
    const zonesLive = join(live, SOUND_ZONES_FILE)
    const before = readFileSync(zonesLive)
    const beforeM = statSync(zonesLive).mtimeMs
    const second = await layers(join(tmp, 'layers-2'), { zones: [zone('z1', 50), zone('z2', 120)], grass: { x: 171, z: 98 } })
    let error: string | null = null
    let stagedZones: string | null = null
    try {
      await convertRegions({ ...base, only: [], liveDir: live, stagingDir: join(tmp, 'stage-a'), edits: second })
      stagedZones = readFileSync(join(tmp, 'stage-a', SOUND_ZONES_FILE), 'utf8')
    } catch (e) {
      error = (e as Error).message
    }
    // the live export is the player-facing map until the Publish swap: nothing may write it
    expect.soft(readFileSync(zonesLive).equals(before), 'the live sound-zones.json was rewritten through the staging hard link').toBe(true)
    expect.soft(statSync(zonesLive).mtimeMs).toBe(beforeM)
    expect.soft(error).toBeNull()
    expect(stagedZones).toContain('z2')
  }, 300_000)

  it('a revert after the Publish (no zones, no grass) gives the unedited export back and lists the two files as removed', async () => {
    const live = join(tmp, 'live-b')
    cpSync(published, live, { recursive: true })
    const empty = await layers(join(tmp, 'layers-empty'), {})
    // the editor's history carries the published region (WE-A passes it in `only`)
    const r = await convertRegions({ ...base, only: [{ x: 171, z: 98 }], liveDir: live, stagingDir: join(tmp, 'stage-b'), edits: empty })
    expect.soft(existsSync(join(tmp, 'stage-b', SOUND_ZONES_FILE)), 'sound-zones.json still in the staging export').toBe(false)
    expect.soft(existsSync(join(tmp, 'stage-b', ...grassRel.split('/'))), 'the grass mask still in the staging export').toBe(false)
    expect.soft(r.removed).toEqual(expect.arrayContaining([SOUND_ZONES_FILE, grassRel]))
    expect(differences(join(tmp, 'plain'), join(tmp, 'stage-b'))).toEqual([])
  }, 300_000)

  it('a full convert ends the record: the next incremental run does not carry the regions published before it', async () => {
    // the record is "the regions earlier incremental runs touched since the last full convert" (convert-region.ts);
    // it is keyed by the pre-pass cache's hash, and a full convert writes the same pre-pass bytes, so it lives on
    const live = join(tmp, 'live-c')
    const cache = join(tmp, 'cache-c', 'prepass.json')
    const record = join(tmp, 'cache-c', 'incremental.json')
    await convertWorld({ ...full, outDir: live, prePassCache: cache })
    const r1 = await convertRegions({ ...base, prePassCache: cache, record, only: [{ x: 172, z: 99 }], liveDir: live, stagingDir: join(tmp, 'stage-c1'), edits: null })
    expect(r1.regions.core).toEqual([(99 << 8) | 172])
    // the full convert (X3, or the user's next `pnpm sro convert`) rebuilds the live export from the layers
    rmSync(live, { recursive: true, force: true })
    await convertWorld({ ...full, outDir: live, prePassCache: cache })
    const r2 = await convertRegions({ ...base, prePassCache: cache, record, only: [], liveDir: live, stagingDir: join(tmp, 'stage-c2'), edits: null })
    expect(r2.regions.core, 'regions carried over the full convert').toEqual([])
  }, 300_000)
})
