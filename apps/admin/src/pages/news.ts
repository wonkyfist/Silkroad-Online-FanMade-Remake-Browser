import {
  NEWS_ID,
  NEWS_IMAGE_MAX_BYTES,
  NEWS_IMAGE_NAME,
  formatNewsDate,
  newsHtml,
  newsImageUrl,
  type AdminNewsPut,
  type AdminNewsRow,
  type AdminNewsView,
} from '@sro/shared'
import { AdminApiError, assetUrl, del, get, post, put } from '../api.ts'
import { attempt, badge, button, card, clear, confirmDialog, emptyState, errorText, h, navigate, pageHeader, toast } from '../ui.ts'

/**
 * News (docs/CHANGELOG_WINDOW.md §4): the entries of the in-game "What's new" window. The repo files
 * (content/changelog) are written at each deploy; a save here writes the panel's copy in DATA_DIR/content/changelog,
 * layered over the repo file (Revert removes it). Images are resized in the browser (at most 1280 px wide, JPEG) before
 * the upload. The preview uses the same renderer as the game, so what you see is what players get.
 */

/** Largest image width kept, and the size each upload aims under. */
const IMAGE_MAX_W = 1280
const IMAGE_TARGET_BYTES = 250 * 1024

const SOURCE: Record<AdminNewsRow['source'], [string, 'dim' | 'gold' | 'info']> = {
  repo: ['repo', 'dim'],
  panel: ['panel', 'gold'],
  edited: ['edited in panel', 'info'],
}

export function newsPage(root: HTMLElement): void {
  const body = h('div')
  root.append(
    pageHeader("What's new", 'The update notes players see at their next login (and under Esc → What\'s new). Newest first.', button('New entry', () => navigate('news/new'), 'primary')),
    body,
  )
  const load = async () => {
    try {
      const view = await get<AdminNewsView>('news')
      const list = view.entries.length
        ? h(
            'div',
            { class: 'news-list' },
            view.entries.map((e) =>
              h(
                'a',
                { class: 'news-item', href: `#/news/${encodeURIComponent(e.id)}` },
                e.hero ? h('img', { class: 'news-item-img', src: imageSrc(e.hero), alt: '', loading: 'lazy' }) : h('div', { class: 'news-item-img news-item-noimg' }),
                h(
                  'div',
                  { class: 'news-item-text' },
                  h('div', { class: 'news-item-meta' }, h('span', { class: 'dim small' }, formatNewsDate(e.date)), badge(...SOURCE[e.source]), e.draft ? badge('draft', 'bad') : null),
                  h('strong', { class: 'news-item-title' }, e.title),
                  e.summary ? h('div', { class: 'dim small news-item-summary' }, e.summary) : null,
                  h('div', { class: 'mono dim small' }, e.id),
                ),
              ),
            ),
          )
        : emptyState('No entries yet. Add one, or write content/changelog/<date>-<slug>.md in the repo.')
      clear(
        body,
        view.problems.length ? h('div', { class: 'notice warn pre' }, h('strong', null, 'Files skipped: '), view.problems.join('\n')) : null,
        card(null, list),
      )
    } catch (e) {
      clear(body, emptyState(errorText(e), 'alert', true))
    }
  }
  void load()
}

/** An image of the store on the active server. */
function imageSrc(name: string): string {
  return assetUrl(newsImageUrl(name)) ?? newsImageUrl(name)
}

/** `My shot (2).PNG` -> `my-shot-2`. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** The picked file as a web JPEG: at most IMAGE_MAX_W wide, quality lowered until it is under IMAGE_TARGET_BYTES. */
async function webJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, IMAGE_MAX_W / bitmap.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const g = canvas.getContext('2d')
  if (!g) throw new Error('this browser cannot resize images')
  // Transparent PNGs get the window's dark background, not black.
  g.fillStyle = '#141210'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  let blob: Blob | null = null
  for (const q of [0.85, 0.78, 0.7, 0.6, 0.5]) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', q))
    if (blob && blob.size <= IMAGE_TARGET_BYTES) break
  }
  if (!blob) throw new Error('the image could not be encoded')
  if (blob.size > NEWS_IMAGE_MAX_BYTES) throw new Error(`the image is still ${Math.round(blob.size / 1024)} KB after resizing (at most ${Math.round(NEWS_IMAGE_MAX_BYTES / 1024)} KB)`)
  return blob
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error ?? new Error('could not read the file'))
    r.readAsDataURL(blob)
  })
}

/** The editor of one entry (`new` = a new one), with the image store and a live preview. */
export function newsEntryPage(root: HTMLElement, args: string[]): void {
  const id = args[0] ?? 'new'
  const isNew = id === 'new'
  const body = h('div')
  root.append(body)
  const load = async () => {
    try {
      const view = await get<AdminNewsView>('news')
      const entry = isNew ? null : (view.entries.find((e) => e.id === id) ?? null)
      if (!isNew && !entry) {
        clear(body, pageHeader('Entry not found'), emptyState(`There is no entry ${id}.`, 'alert', true))
        return
      }
      render(entry, view.images)
    } catch (e) {
      clear(body, emptyState(errorText(e), 'alert', true))
    }
  }

  const render = (entry: AdminNewsRow | null, images: string[]) => {
    const today = new Date().toISOString().slice(0, 10)
    const field = (label: string, input: HTMLElement, hint?: string) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null)
    const idIn = h('input', { class: 'input mono', value: entry?.id ?? `${today}-`, maxlength: 80, spellcheck: 'false', disabled: !isNew })
    const dateIn = h('input', { class: 'input mono', value: entry?.date ?? today, maxlength: 16, spellcheck: 'false' })
    const titleIn = h('input', { class: 'input', value: entry?.title ?? '', maxlength: 120 })
    const summaryIn = h('textarea', { class: 'input', rows: 2, maxlength: 400, value: entry?.summary ?? '' })
    const heroSel = h('select', { class: 'input' }, h('option', { value: '' }, '(none)'), images.map((n) => h('option', { value: n, selected: n === entry?.hero }, n)))
    const draftIn = h('input', { type: 'checkbox', checked: entry?.draft === true })
    const text = h('textarea', { class: 'input mono news-body-input', rows: 24, spellcheck: 'true', value: entry?.body ?? '## Heading\n\nWhat changed, for players.\n\n- One thing\n- Another thing\n' })
    const issues = h('div', { class: 'form-error' })
    const preview = h('div', { class: 'news-preview' })
    const imageList = h('div', { class: 'news-images' })

    const insert = (snippet: string) => {
      const at = text.selectionStart ?? text.value.length
      const before = text.value.slice(0, at)
      const pad = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
      text.value = `${before}${pad}${snippet}\n\n${text.value.slice(text.selectionEnd ?? at).replace(/^\n+/, '')}`
      text.focus()
      renderPreview()
    }

    const renderImages = () => {
      clear(
        imageList,
        images.length
          ? images.map((n) =>
              h(
                'div',
                { class: 'news-image' },
                h('img', { src: imageSrc(n), alt: n, loading: 'lazy' }),
                h('div', { class: 'mono small news-image-name' }, n),
                h('div', { class: 'actions' }, button('Insert', () => insert(`![](img/${n} "Caption")`), 'small'), button('Hero', () => {
                  heroSel.value = n
                  renderPreview()
                }, 'small')),
              ),
            )
          : h('p', { class: 'dim small' }, 'No images yet.'),
      )
    }

    const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'sr-only', id: 'news-upload' })
    const upload = h('label', { class: 'btn', for: 'news-upload' }, 'Upload image…')
    fileIn.addEventListener('change', async () => {
      const file = fileIn.files?.[0]
      fileIn.value = ''
      if (!file) return
      try {
        const blob = await webJpeg(file)
        const stem = slug(file.name) || 'image'
        let name = `${stem}.jpg`
        for (let n = 2; images.includes(name); n++) name = `${stem}-${n}.jpg`
        if (!NEWS_IMAGE_NAME.test(name)) throw new Error(`cannot make a file name from ${file.name}`)
        const r = await post<{ name: string; bytes: number; images: string[] }>('news-images', { name, data: await base64(blob) })
        images = r.images
        const keep = heroSel.value
        heroSel.replaceChildren(h('option', { value: '' }, '(none)'), ...images.map((n) => h('option', { value: n }, n)))
        heroSel.value = keep
        renderImages()
        insert(`![](img/${r.name} "Caption")`)
        toast(`Uploaded ${r.name} (${Math.round(r.bytes / 1024)} KB).`)
      } catch (e) {
        toast(errorText(e), 'error')
      }
    })

    const current = (): AdminNewsPut => ({
      date: dateIn.value.trim(),
      title: titleIn.value,
      summary: summaryIn.value,
      ...(heroSel.value ? { hero: heroSel.value } : {}),
      draft: draftIn.checked,
      body: text.value,
    })

    let raf = 0
    const renderPreview = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const e = current()
        // newsHtml escapes everything and keeps only images of the store; the title and summary go in as text.
        const md = h('div', { class: 'news-md' })
        md.innerHTML = newsHtml(e.body, { imageUrl: imageSrc })
        clear(
          preview,
          h('div', { class: 'news-p-date' }, formatNewsDate(e.date)),
          h('h2', { class: 'news-p-title' }, e.title || '(title)'),
          e.summary ? h('p', { class: 'news-p-summary' }, e.summary) : null,
          e.hero ? h('figure', { class: 'nw-fig' }, h('img', { src: imageSrc(e.hero), alt: '' })) : null,
          md,
        )
      })
    }
    for (const el of [dateIn, titleIn, summaryIn, heroSel, text]) el.addEventListener('input', renderPreview)
    heroSel.addEventListener('change', renderPreview)

    const save = button(isNew ? 'Create entry' : 'Save', async () => {
      const newId = isNew ? idIn.value.trim() : id
      if (!NEWS_ID.test(newId)) return void (issues.textContent = 'id: lower-case letters, digits and dashes (e.g. 2026-10-12-siege)')
      issues.textContent = ''
      try {
        const r = await put<AdminNewsRow>(`news/${encodeURIComponent(newId)}`, current())
        toast(`Saved ${r.id}${r.draft ? ' (draft: players do not see it)' : ''}.`)
        if (isNew) navigate(`news/${r.id}`)
        else void load()
      } catch (e) {
        issues.textContent = e instanceof AdminApiError && e.issues.length ? e.issues.map((i) => i.message).join('\n') : errorText(e)
        toast('Not saved.', 'error')
      }
    }, 'primary')
    const revert =
      entry && entry.source !== 'repo'
        ? button(entry.source === 'edited' ? 'Revert to repo…' : 'Delete…', async () => {
            const ok = await confirmDialog({
              title: entry.source === 'edited' ? 'Revert entry' : 'Delete entry',
              message: entry.source === 'edited' ? `Remove the panel's copy of ${entry.id}? The repo version comes back.` : `Delete ${entry.id}? It exists only in the panel.`,
              confirm: entry.source === 'edited' ? 'Revert' : 'Delete',
              danger: true,
            })
            if (!ok) return
            if (await attempt(() => del(`news/${encodeURIComponent(entry.id)}`), entry.source === 'edited' ? 'Reverted.' : 'Deleted.')) {
              if (entry.source === 'edited') void load()
              else navigate('news')
            }
          }, 'danger')
        : null

    clear(
      body,
      pageHeader(isNew ? 'New entry' : entry!.title, isNew ? 'Written for players: what changed and why it matters to them.' : `${entry!.id} · ${SOURCE[entry!.source][0]}`, ...[revert, save].filter((x): x is HTMLButtonElement => !!x)),
      entry?.source === 'repo' ? h('div', { class: 'notice info' }, 'This entry comes from the repo. Saving here keeps a panel copy that wins over the repo file until you revert it.') : null,
      h(
        'div',
        { class: 'news-editor' },
        h(
          'div',
          { class: 'news-edit-col' },
          card(
            null,
            h(
              'div',
              { class: 'form' },
              h('div', { class: 'news-row2' }, field('Id', idIn, 'The file name: yyyy-mm-dd-slug.'), field('Date', dateIn, 'yyyy-mm-dd, or yyyy-mm-ddThh:mm (UTC) to order two entries of a day.')),
              field('Title', titleIn),
              field('Summary', summaryIn, 'One or two sentences: the lead of the window and the line in the list.'),
              h('div', { class: 'news-row2' }, field('Hero image', heroSel, 'Shown above the text.'), h('label', { class: 'field field-check' }, draftIn, h('span', { class: 'field-label' }, 'Draft'), h('span', { class: 'field-hint' }, 'Players do not see drafts.'))),
              field('Text', text, 'Markdown: ## heading, **bold**, *italic*, - lists, 1. lists, > note, --- rule, ![alt](img/file.jpg "caption") on its own line (consecutive image lines sit side by side). No HTML; links show as text.'),
              issues,
            ),
          ),
          card('Images', h('p', { class: 'dim small' }, `Uploads are resized here to at most ${IMAGE_MAX_W} px wide (JPEG, aiming under ${IMAGE_TARGET_BYTES / 1024} KB).`), h('div', { class: 'actions' }, upload, fileIn), imageList),
        ),
        h('div', { class: 'news-preview-col' }, card('Preview', preview)),
      ),
    )
    renderImages()
    renderPreview()
  }
  void load()
}
