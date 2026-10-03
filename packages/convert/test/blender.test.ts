/**
 * W10-CV: packages/convert/src/blender.ts (docs/WAVE_PLAN6.md D19; docs/COAST.md §6.6 finding 1).
 * - every path handed to Blender must be absolute: a relative script, .blend, cwd or path-like argument is refused
 *   before anything spawns (the Windows drive-relative `\x` and Blender's `//x` included);
 * - blenderPath: the `blenderExe` key, else the 5.2 default install; a relative configured path resolves in the repo;
 * - with Blender installed: a headless script writes to an absolute path, and a Python exception fails the run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  blenderArgs, blenderPath, blenderVersion, defaultBlenderExe, isAbsolutePath, looksLikePath, relativePaths, runBlender,
} from '../src/blender.ts'
import { REPO_ROOT } from '../src/node-io.ts'

const WIN_SCRIPT = 'C:\\dev\\silkroad\\packages\\convert\\tools\\blender\\build_edge.py'

describe('blender.ts: absolute paths only', () => {
  it('isAbsolutePath (Windows): drive and UNC paths only', () => {
    for (const p of ['C:\\work\\x.png', 'c:/work/x.png', '\\\\server\\share\\x.blend']) expect(isAbsolutePath(p, 'win32'), p).toBe(true)
    for (const p of ['work/tmp/x.png', 'x.blend', '.\\x.py', '..\\x', '\\work\\x.png', '/work/x.png', '//x.png', 'C:x.png']) {
      expect(isAbsolutePath(p, 'win32'), p).toBe(false)
    }
  })

  it('isAbsolutePath (POSIX): a leading / but never Blender\'s //', () => {
    expect(isAbsolutePath('/home/u/x.blend', 'linux')).toBe(true)
    for (const p of ['work/x.png', './x', '//x.png', 'C:\\x']) expect(isAbsolutePath(p, 'linux'), p).toBe(false)
  })

  it('looksLikePath: separators or a file extension, not plain values', () => {
    for (const a of ['work/x', 'out.blend', 'a\\b', 'x.png']) expect(looksLikePath(a), a).toBe(true)
    for (const a of ['173-175,89-91', '42', '0.5', '-2.5', 'procedural', 'gullies', 'jangan-fields']) expect(looksLikePath(a), a).toBe(false)
  })

  it('refuses a relative script, .blend, cwd or path-like argument, and names each', () => {
    const bad = relativePaths({
      script: 'packages/convert/tools/blender/build_edge.py',
      blend: 'edge.blend',
      cwd: 'work',
      args: ['C:\\ok\\bundle.json', 'work/tmp/coast-refresh/rt/oblique.png', '--out=rt/topdown.png', '--area', '173-175,89-91', '--seed', '7'],
    }, 'win32')
    expect(bad).toEqual([
      'script "packages/convert/tools/blender/build_edge.py"',
      'blend "edge.blend"',
      'cwd "work"',
      'argument "work/tmp/coast-refresh/rt/oblique.png"',
      'argument "--out=rt/topdown.png"',
    ])
    expect(() => blenderArgs({ script: 'build_edge.py' }, 'win32')).toThrow(/must be absolute/)
    expect(() => blenderArgs({ script: WIN_SCRIPT, args: ['\\work\\x.png'] }, 'win32')).toThrow(/\\\\work\\\\x.png/)
  })

  it('passes absolute paths and plain values through, `{ value }` unchecked', () => {
    const args = blenderArgs({
      script: WIN_SCRIPT, blend: 'C:\\w\\edge.blend',
      args: ['C:\\w\\bundle.json', '--area', '173-175,89-91', '--out=C:\\w\\top.png', { value: 'a/b' }],
    }, 'win32')
    expect(args).toEqual([
      '--background', '--factory-startup', 'C:\\w\\edge.blend', '--python-exit-code', '1', '--python', WIN_SCRIPT, '--',
      'C:\\w\\bundle.json', '--area', '173-175,89-91', '--out=C:\\w\\top.png', 'a/b',
    ])
    expect(blenderArgs({ script: '/r/x.py', background: false, factoryStartup: false }, 'linux'))
      .toEqual(['--python-exit-code', '1', '--python', '/r/x.py', '--'])
  })

  it('runBlender rejects a relative path before spawning', async () => {
    await expect(runBlender({ blenderExe: 'C:\\no\\such\\blender.exe' }, { script: 'x.py' })).rejects.toThrow(/must be absolute/)
    await expect(runBlender({ blenderExe: join(REPO_ROOT, 'no-such-blender.exe') }, { script: join(REPO_ROOT, 'x.py') }))
      .rejects.toThrow(/Blender not found/)
  })
})

describe('blender.ts: the executable', () => {
  it('the blenderExe key wins; else the 5.2 default install', () => {
    expect(defaultBlenderExe('win32')).toBe('C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe')
    expect(blenderPath(undefined, 'win32')).toBe(defaultBlenderExe('win32'))
    expect(blenderPath({ blenderExe: '  ' }, 'win32')).toBe(defaultBlenderExe('win32'))
    expect(blenderPath({ blenderExe: 'D:\\Blender\\blender.exe' }, 'win32')).toBe('D:\\Blender\\blender.exe')
    expect(blenderPath({ blenderExe: 'blender' }, 'linux')).toBe('blender')
    expect(blenderPath({ blenderExe: 'work/tools/blender/blender.exe' })).toBe(join(REPO_ROOT, 'work/tools/blender/blender.exe'))
  })
})

const version = blenderVersion()

describe.skipIf(!version)('blender.ts: a real headless run', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sro-blender-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it(`runs a script with absolute paths (${version})`, async () => {
    const script = join(tmp, 'probe.py')
    const out = join(tmp, 'probe.json')
    writeFileSync(script, [
      'import sys, json, bpy',
      'argv = sys.argv[sys.argv.index("--") + 1:]',
      'json.dump({"args": argv, "version": bpy.app.version_string, "objects": len(bpy.data.objects)}, open(argv[0], "w"))',
      'print("probe ok")',
    ].join('\n'))
    const lines: string[] = []
    const r = await runBlender(undefined, { script, args: [out, '--area', '173-175,89-91'], onLine: l => lines.push(l), timeoutMs: 90_000 })
    expect(r.code).toBe(0)
    expect(lines).toContain('probe ok')
    const probe = JSON.parse(readFileSync(out, 'utf8')) as { args: string[]; version: string; objects: number }
    expect(probe.args).toEqual([out, '--area', '173-175,89-91'])
    expect(existsSync(join('C:\\', 'probe.json'))).toBe(false)
  }, 120_000)

  it('a Python exception fails the run', async () => {
    const script = join(tmp, 'fail.py')
    writeFileSync(script, 'raise RuntimeError("probe failure")\n')
    await expect(runBlender(undefined, { script, timeoutMs: 90_000 })).rejects.toThrow(/probe failure|exited with 1/)
  }, 120_000)
})
