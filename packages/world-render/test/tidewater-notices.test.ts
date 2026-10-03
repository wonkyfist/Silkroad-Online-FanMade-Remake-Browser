/**
 * The Tidewater notice (docs/COAST.md §8.12 S-NOTICE; docs/WAVE_PLAN6.md D14): the repository's THIRD_PARTY_NOTICES.md
 * carries the Tidewater entry (the commit, the MIT text with its copyright line), and its file list matches the code:
 * every source file with the Tidewater header is listed, and every listed file exists and carries the header. W10-S
 * creates the file with an empty list; CST-O and CST-S append the files they port.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const NOTICES = join(REPO, 'THIRD_PARTY_NOTICES.md')
/** The header's fixed part (the file name in it varies). */
const HEADER = /Portions ported from Tidewater \(github\.com\/dgreenheck\/tidewater, `?[^`)]+`? at `?4811ba4`?\), MIT licen[cs]e, Copyright \(c\)\s*(?:\*\s*|\/\/\s*)?2026 DRG Software Solutions LLC/
/** Where ported code may live (every package's and app's sources, and the converter's tools). */
const ROOTS = ['packages', 'apps']
const SKIP = new Set(['node_modules', 'dist', 'test', '.vite'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|js|mjs|wgsl|glsl|py)$/.test(name)) out.push(p)
  }
  return out
}

/** The listed files (repository paths) between the tidewater-files markers. */
function listed(md: string): string[] {
  const m = /<!-- tidewater-files:start -->([\s\S]*?)<!-- tidewater-files:end -->/.exec(md)
  expect(m, 'the file list markers').not.toBeNull()
  return [...m![1]!.matchAll(/^- `?([^`\s]+)`?\s*$/gm)].map(x => x[1]!)
}

describe('THIRD_PARTY_NOTICES.md: the Tidewater entry', () => {
  const md = existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8') : ''

  it('exists at the repository root with the project, the pinned commit and the full MIT text with its copyright line', () => {
    expect(md.length).toBeGreaterThan(0)
    expect(md).toContain('## Tidewater')
    expect(md).toContain('https://github.com/dgreenheck/tidewater')
    expect(md).toContain('`4811ba4`')
    expect(md).toContain('MIT License')
    expect(md).toContain('Copyright (c) 2026 DRG Software Solutions LLC')
    expect(md).toContain('Permission is hereby granted, free of charge')
    expect(md).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND')
  })

  it('lists every source file with the Tidewater header, and every listed file exists and carries it', () => {
    const files = listed(md)
    for (const f of files) {
      const p = join(REPO, f)
      expect(existsSync(p), `${f} is listed but missing`).toBe(true)
      expect(HEADER.test(readFileSync(p, 'utf8')), `${f} is listed but has no Tidewater header`).toBe(true)
    }
    const withHeader = ROOTS.flatMap(r => sourceFiles(join(REPO, r)))
      .filter(p => /Portions ported from Tidewater/.test(readFileSync(p, 'utf8')))
      .map(p => relative(REPO, p).split('\\').join('/'))
    for (const f of withHeader) expect(files, `${f} has the Tidewater header but is not listed`).toContain(f)
    expect(new Set(files).size).toBe(files.length)
  })

  it('the header rule matches COAST §8.12\'s wording', () => {
    const header = '// Portions ported from Tidewater (github.com/dgreenheck/tidewater, `OceanFFT.js` at `4811ba4`), MIT licence, Copyright (c) 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.'
    expect(HEADER.test(header)).toBe(true)
    const wrapped = '/**\n * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `CDLOD.js` at `4811ba4`), MIT licence, Copyright (c)\n * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.\n */'
    expect(HEADER.test(wrapped)).toBe(true)
    expect(md).toContain('Portions ported from Tidewater (github.com/dgreenheck/tidewater, `<file>` at `4811ba4`)')
  })
})
