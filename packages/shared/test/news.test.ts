import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NEWS_IMAGE_MAX_BYTES,
  NEWS_UNSEEN_MAX,
  checkNewsEntry,
  compareNews,
  formatNewsDate,
  newsDateKey,
  newsHtml,
  newsImageName,
  newsImageRefs,
  parseNewsFile,
  parseNewsInline,
  parseNewsMarkdown,
  serializeNewsFile,
  sortNews,
  unseenNews,
  type NewsEntry,
} from '../src/index.ts'

const FILE = `---
id: 2026-10-05-test
date: 2026-10-05
title: October 5: a test
summary: One line.
hero: hero.jpg
---
## Heading

Some **bold** text.
`

const entry = (id: string, date: string): NewsEntry => ({ id, date, title: id, summary: '', body: '' })

describe('entry files', () => {
  it('reads the front matter (a colon in the title is kept) and the body', () => {
    const r = parseNewsFile(FILE, '2026-10-05-test')
    expect(r).toEqual({ entry: { id: '2026-10-05-test', date: '2026-10-05', title: 'October 5: a test', summary: 'One line.', hero: 'hero.jpg', body: '## Heading\n\nSome **bold** text.' } })
  })

  it('round-trips through serializeNewsFile', () => {
    const r = parseNewsFile(FILE, '2026-10-05-test')
    if (!('entry' in r)) throw new Error(r.problems.join())
    expect(parseNewsFile(serializeNewsFile({ ...r.entry, draft: true }), r.entry.id)).toEqual({ entry: { ...r.entry, draft: true } })
  })

  it('takes the id from the file name and refuses a mismatch, unknown keys, bad dates and missing images', () => {
    expect(parseNewsFile(FILE.replace('id: 2026-10-05-test\n', ''), '2026-10-05-test')).toHaveProperty('entry.id', '2026-10-05-test')
    expect(parseNewsFile(FILE, 'other')).toHaveProperty('problems')
    expect(parseNewsFile(FILE.replace('summary:', 'sumary:'), '2026-10-05-test')).toHaveProperty('problems')
    expect(parseNewsFile(FILE.replace('2026-10-05\n', '2026-13-05\n'), '2026-10-05-test')).toHaveProperty('problems')
    expect(parseNewsFile('no front matter', 'x')).toHaveProperty('problems')
    expect(parseNewsFile(FILE, '2026-10-05-test', new Set(['other.jpg']))).toEqual({ problems: ['hero: no image hero.jpg'] })
    expect(parseNewsFile(`${FILE}\n![x](http://evil.example/a.jpg)\n`, '2026-10-05-test')).toHaveProperty('problems')
  })

  it('checkNewsEntry cleans control and bidi characters from one-line fields', () => {
    const r = checkNewsEntry({ id: 'a', date: '2026-10-05', title: 'Hi\u202Ethere\u0007', summary: 'x\ny', body: 'b' })
    expect(r).toEqual({ entry: { id: 'a', date: '2026-10-05', title: 'Hithere', summary: 'x y', body: 'b' } })
    expect(checkNewsEntry({ id: 'A B', date: 'x', title: '', body: 1, extra: true })).toHaveProperty('problems')
  })

  it('the repo entries parse with every image present and within the size budget', () => {
    const dir = fileURLToPath(new URL('../../../content/changelog', import.meta.url))
    const images = new Set(readdirSync(join(dir, 'img')))
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const f of files) {
      const r = parseNewsFile(readFileSync(join(dir, f), 'utf8'), f.slice(0, -3), images)
      expect(r, f).toHaveProperty('entry')
    }
    for (const img of images) expect(readFileSync(join(dir, 'img', img)).length, img).toBeLessThan(Math.min(NEWS_IMAGE_MAX_BYTES, 250 * 1024))
  })
})

describe('order and the unseen rule', () => {
  it('orders by date and time, then id; formats the date', () => {
    expect(newsDateKey('2026-10-05')).toBe('2026-10-05T00:00')
    expect(newsDateKey('2026-10-05T22:00')).toBe('2026-10-05T22:00')
    expect(newsDateKey('2026-10-05 25:00')).toBeNull()
    const list = sortNews([entry('a', '2026-10-05T15:00'), entry('c', '2026-10-01'), entry('b', '2026-10-05T22:00'), entry('d', '2026-10-05T15:00')])
    expect(list.map((e) => e.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(compareNews(entry('a', '2026-10-05'), entry('a', '2026-10-05'))).toBe(0)
    expect(formatNewsDate('2026-10-05T22:00')).toBe('October 5, 2026')
  })

  it('with a mark: everything newer; without: from the account creation day; at most NEWS_UNSEEN_MAX', () => {
    const all = [entry('old', '2026-09-01'), entry('mid', '2026-10-01'), entry('new', '2026-10-05T15:00'), entry('newer', '2026-10-05T22:00')]
    expect(unseenNews(all, { date: '2026-10-01', id: 'mid' }, 0).map((e) => e.id)).toEqual(['newer', 'new'])
    expect(unseenNews(all, { date: '2026-10-05T22:00', id: 'newer' }, 0)).toEqual([])
    expect(unseenNews(all, null, Date.UTC(2026, 9, 1, 18)).map((e) => e.id)).toEqual(['newer', 'new', 'mid'])
    expect(unseenNews(all, null, Date.UTC(2026, 9, 6))).toEqual([])
    const many = Array.from({ length: 9 }, (_, i) => entry(`e${i}`, `2026-10-0${i + 1}`))
    expect(unseenNews(many, null, 0).map((e) => e.id)).toEqual(['e8', 'e7', 'e6', 'e5', 'e4'].slice(0, NEWS_UNSEEN_MAX))
  })
})

describe('Markdown', () => {
  it('parses headings, paragraphs, lists, images, rows, notes and rules', () => {
    const md = '# One\n\nline a\nline b\n\n- x\n- **y**\n  more\n\n1. first\n2. second\n\n![Alt](img/a.jpg "Cap")\n\n![b](b.png)\n![c](/api/news/img/c.webp)\n\n> note\n\n---'
    expect(parseNewsMarkdown(md)).toEqual([
      { k: 'h', level: 1, c: [{ k: 'text', text: 'One' }] },
      { k: 'p', c: [{ k: 'text', text: 'line a line b' }] },
      { k: 'ul', items: [[{ k: 'text', text: 'x' }], [{ k: 'b', c: [{ k: 'text', text: 'y' }] }, { k: 'text', text: ' more' }]] },
      { k: 'ol', items: [[{ k: 'text', text: 'first' }], [{ k: 'text', text: 'second' }]] },
      { k: 'img', img: { src: 'a.jpg', alt: 'Alt', caption: 'Cap' } },
      { k: 'row', imgs: [{ src: 'b.png', alt: 'b', caption: 'b' }, { src: 'c.webp', alt: 'c', caption: 'c' }] },
      { k: 'quote', c: [{ k: 'text', text: 'note' }] },
      { k: 'hr' },
    ])
  })

  it('inline: bold, italic, code, links keep only their text, snake_case stays plain, escapes', () => {
    expect(parseNewsInline('a *b* _c_ `d` [e](http://x) snake_case_word \\*f\\*')).toEqual([
      { k: 'text', text: 'a ' },
      { k: 'i', c: [{ k: 'text', text: 'b' }] },
      { k: 'text', text: ' ' },
      { k: 'i', c: [{ k: 'text', text: 'c' }] },
      { k: 'text', text: ' ' },
      { k: 'code', text: 'd' },
      { k: 'text', text: ' e snake_case_word *f*' },
    ])
  })

  it('only images of the changelog image store', () => {
    expect(newsImageName('img/a-b_1.jpg')).toBe('a-b_1.jpg')
    expect(newsImageName('./img/a.png')).toBe('a.png')
    expect(newsImageName('/api/news/img/a.webp')).toBe('a.webp')
    for (const bad of ['../a.jpg', 'img/../../a.jpg', 'http://x/a.jpg', '//x/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'A.JPG', 'a.svg', 'a.gif', 'img/sub/a.jpg', 'a.jpg?x=1']) {
      expect(newsImageName(bad), bad).toBeNull()
    }
    expect(newsImageRefs('![a](a.jpg)\n![b](http://x/b.jpg)\ntext ![c](c.jpg) inline')).toEqual({ ok: ['a.jpg'], bad: ['http://x/b.jpg'] })
  })
})

describe('the HTML renderer is safe', () => {
  const html = (md: string) => newsHtml(md)

  it('escapes raw HTML everywhere', () => {
    const out = html('<script>alert(1)</script>\n\n## <img src=x onerror=alert(1)>\n\n- <b>x</b>\n\n**<i>y</i>** `<z>` "q" \'s\' & done')
    expect(out).not.toMatch(/<script|<img|<b>|<i>|<z>/)
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(out).toContain('<code>&lt;z&gt;</code>')
    expect(out).toContain('&quot;q&quot; &#39;s&#39; &amp; done')
  })

  it('attributes cannot be broken out of, and links never become anchors', () => {
    const out = html('![x" onerror="alert(1)](a.jpg "c <b onload=x> \' onload=\'y")\n\n[click](javascript:alert(1)) [y](http://evil.example)')
    expect(out).not.toContain('<a')
    expect(out).not.toContain('javascript:')
    expect(out).not.toMatch(/ onerror="/)
    expect(out).not.toMatch(/ onload="/)
    expect(out).toContain('<img src="/api/news/img/a.jpg" alt="x&quot; onerror=&quot;alert(1)"')
  })

  it('drops images from anywhere else, and uses the caller\'s image URL', () => {
    expect(html('![a](http://evil.example/a.jpg)\n\n![b](../b.jpg)')).toBe('')
    expect(newsHtml('![a](a.jpg)', { imageUrl: (n) => `https://cdn.test/${n}` })).toContain('src="https://cdn.test/a.jpg"')
  })

  it('renders the blocks', () => {
    expect(html('# T\n\nA *b*\n\n- c\n\n> d\n\n---')).toBe('<h3 class="nw-h nw-h1">T</h3>\n<p>A <em>b</em></p>\n<ul><li>c</li></ul>\n<blockquote>d</blockquote>\n<hr>')
  })
})
