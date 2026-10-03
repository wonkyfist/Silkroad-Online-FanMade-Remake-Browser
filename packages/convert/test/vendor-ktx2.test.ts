/**
 * TP-K decoder vendoring (docs/WAVE_PLAN3.md §7.1): the tar reader, the pins (every runtime URL has a pinned file,
 * the pins match the workspace's Babylon), and an offline vendoring run from the cached npm tarballs
 * (work/tools/ktx2decoder; skips without them).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  KTX2_DECODER_DIR, KTX2_DECODER_VERSION, KTX2_SOURCES, KTX2_VENDORED_FILES, checkVendored, installedBabylonVersion,
  npmIntegrity, parseTar, sha256, vendorKtx2,
} from '../src/tools/vendor-ktx2.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const CACHE = join(REPO, 'work', 'tools', 'ktx2decoder')

/** A minimal ustar archive (one header + data per file). */
function tar(files: Record<string, string>, prefix?: string): Uint8Array {
  const parts: Buffer[] = []
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8')
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write(data.length.toString(8).padStart(11, '0'), 124, 'ascii')
    h.write('0', 156, 'ascii')
    h.write('ustar', 257, 'ascii')
    if (prefix) h.write(prefix, 345, 'utf8')
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return new Uint8Array(Buffer.concat(parts))
}

describe('tar reader', () => {
  it('reads regular files, including the ustar prefix', () => {
    const t = parseTar(tar({ 'a.txt': 'hello', 'b/c.wasm': 'x'.repeat(700) }))
    expect(Buffer.from(t.get('a.txt')!).toString()).toBe('hello')
    expect(t.get('b/c.wasm')!.byteLength).toBe(700)
    expect(parseTar(tar({ 'n.js': '1' }, 'package')).has('package/n.js')).toBe(true)
  })
})

describe('pins', () => {
  it('match the workspace Babylon and come from the npm registry only', () => {
    expect(installedBabylonVersion()).toBe(KTX2_DECODER_VERSION)
    for (const s of Object.values(KTX2_SOURCES)) {
      expect(s.version).toBe(KTX2_DECODER_VERSION)
      expect(s.tarball.startsWith('https://registry.npmjs.org/')).toBe(true)
      expect(s.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
    }
  })

  it('pin a sha256 for every file, with unique names, including the decoder, all wasm and the licences', () => {
    const names = KTX2_VENDORED_FILES.map(f => f.name)
    expect(new Set(names).size).toBe(names.length)
    for (const f of KTX2_VENDORED_FILES) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(names).toContain('babylon.ktx2Decoder.js')
    expect(names.filter(n => n.endsWith('.wasm')).length).toBe(8)
    expect(names).toContain('NOTICE.md')
  })

  it('npmIntegrity is the registry form', () => {
    expect(npmIntegrity(new Uint8Array(0))).toBe('sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==')
  })
})

const HAVE_CACHE = Object.values(KTX2_SOURCES).every(s => existsSync(join(CACHE, `${s.name.replace('@', '').replace('/', '__')}-${s.version}.tgz`)))

describe.skipIf(!HAVE_CACHE)('offline vendoring from the cached tarballs', () => {
  const work = mkdtempSync(join(tmpdir(), 'sro-ktx2-vendor-'))
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  it('writes every pinned file and the manifest, and the check catches a tampered file', async () => {
    const { dirs, manifest } = await vendorKtx2({ work, cacheDir: CACHE, offline: true })
    expect(dirs).toEqual([join(work, 'out', KTX2_DECODER_DIR)])
    expect(manifest.files.length).toBe(KTX2_VENDORED_FILES.length)
    expect(checkVendored(dirs[0]!)).toEqual([])
    const m = JSON.parse(readFileSync(join(dirs[0]!, 'ktx2-decoders.json'), 'utf8')) as typeof manifest
    expect(m.babylon).toBe(KTX2_DECODER_VERSION)
    const js = join(dirs[0]!, 'babylon.ktx2Decoder.js')
    expect(sha256(readFileSync(js))).toBe(KTX2_VENDORED_FILES[0]!.sha256)
    // The decoder's only URLs are Babylon's CDN defaults, which URLConfig replaces (world-render ktx2.ts).
    writeFileSync(js, 'tampered')
    expect(checkVendored(dirs[0]!)).toEqual(['babylon.ktx2Decoder.js: sha256 mismatch'])
  })
})
