import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anchor, changelogMarkdown, loadEntries, rebaseImages } from '../src/cli/changelog-md.ts'
import { REPO_ROOT } from '../src/config.ts'

describe('CHANGELOG.md (pnpm changelog)', () => {
  it('points image paths at content/changelog/img/', () => {
    expect(rebaseImages('![a](img/oct6-x.jpg "cap")')).toBe('![a](content/changelog/img/oct6-x.jpg "cap")')
    expect(rebaseImages('![a](oct6-x.jpg)')).toBe('![a](content/changelog/img/oct6-x.jpg)')
    expect(rebaseImages('[link](https://example.com/a.jpg)')).toBe('[link](https://example.com/a.jpg)')
  })

  it("makes GitHub's heading anchors", () => {
    expect(anchor('October 5 (evening): Storms, lightning, a tornado')).toBe('october-5-evening-storms-lightning-a-tornado')
  })

  it('is up to date with content/changelog (run pnpm changelog after adding an entry)', () => {
    const want = changelogMarkdown(loadEntries())
    expect(readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8')).toBe(want)
  })
})
