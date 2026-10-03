/**
 * The Publish report page inside the editor (docs/WORLD_EDITOR.md §6.4): the model of ./publish-report.ts drawn as
 * one scrolling panel over the map: the headline, the steps while it runs, what you changed, what closed for walking
 * and why, the ten checks (green / amber / red, with the way out), the budgets, the tests, the before / after pairs,
 * and the buttons Keep, Go back and Test in game (Undo this publish once kept). Closing the panel never throws a build
 * away: Publish… opens it again.
 */
import { escapeHtml, type PublishRunView, type ReportModel, type SheetView, type Tone } from './publish-report.ts'

export interface PanelHandlers {
  keep(): void
  goBack(): void
  undo(): void
  testInGame(): void
  /** Fly the editor's camera to a view (the before / after fallback: look at the live preview). */
  look(v: SheetView): void
  /** The API's own report page, in a new tab. */
  fullReport(run: number): void
  /** Select an object a check names (the panel closes so it can be seen; Publish… brings it back). */
  show(ref: string): void
}

const DOT: Record<Tone, string> = { ok: '●', warn: '▲', bad: '■', busy: '◌', muted: '○' }
const STEP_MARK: Record<string, string> = { done: '✓', running: '…', failed: '✗', skipped: '–', waiting: '·' }

export class PublishPanel {
  private views: SheetView[] = []
  private run: PublishRunView | null = null

  constructor(private readonly root: HTMLElement, private readonly handlers: PanelHandlers) {
    root.addEventListener('click', e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
      if (!t || (t as HTMLButtonElement).disabled) return
      const act = t.dataset.act
      if (act === 'close') this.hide()
      else if (act === 'keep') handlers.keep()
      else if (act === 'back') handlers.goBack()
      else if (act === 'undo') handlers.undo()
      else if (act === 'test') handlers.testInGame()
      else if (act === 'full' && this.run) handlers.fullReport(this.run.id)
      else if (act === 'show' && t.dataset.ref) {
        this.hide()
        handlers.show(t.dataset.ref)
      }
      else if (act === 'look') {
        const v = this.views[Number(t.dataset.i)]
        if (v) handlers.look(v)
      }
    })
    // keys typed in the panel never reach the editor's tools
    root.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.hide()
      e.stopPropagation()
    })
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden')
  }

  hide(): void {
    this.root.classList.add('hidden')
  }

  /** The record's views (the "Look" links when the sheet has no pictures). */
  setViews(views: readonly SheetView[]): void {
    this.views = [...views]
  }

  show(model: ReportModel, run: PublishRunView): void {
    const scroll = this.root.querySelector('.body')?.scrollTop ?? 0
    this.run = run
    this.root.classList.remove('hidden')
    this.root.innerHTML = this.html(model, run)
    const body = this.root.querySelector('.body')
    if (body) body.scrollTop = scroll
  }

  private html(m: ReportModel, run: PublishRunView): string {
    const e = escapeHtml
    const sec = (title: string, body: string) => (body ? `<section><h4>${e(title)}</h4>${body}</section>` : '')
    const list = (lines: readonly string[]) => (lines.length ? `<ul>${lines.map(l => `<li>${e(l)}</li>`).join('')}</ul>` : '')
    const steps = m.steps.length && (run.state === 'running' || run.state === 'failed' || run.state === 'stopped')
      ? `<ol class="steps">${m.steps.map(s => `<li class="${s.state}"><span class="mk">${STEP_MARK[s.state] ?? '·'}</span>${e(s.label)}${s.ms !== undefined && s.state !== 'running' ? ` <span class="muted">${(s.ms / 1000).toFixed(1)} s</span>` : ''}${s.note ? ` <span class="muted">${e(s.note)}</span>` : ''}</li>`).join('')}</ol>`
      : ''
    const checks = m.checks.length
      ? `<table class="checks">${m.checks.map(c => `<tr class="${c.tone}"><td class="dot">${DOT[c.tone]}</td><td><b>${e(c.title)}</b><div>${e(c.summary)}</div>${c.items.length ? `<ul>${c.items.map((t, i) => `<li>${e(t)}${c.refs[i] ? ` <button class="show" data-act="show" data-ref="${e(c.refs[i]!)}" title="Select it in the editor (the report closes; Publish… opens it again)">Show</button>` : ''}</li>`).join('')}</ul>` : ''}${c.advice ? `<div class="advice">${e(c.advice)}</div>` : ''}</td></tr>`).join('')}</table>`
      : ''
    let sheet = ''
    if (m.sheet.length) {
      sheet = `<div class="sheet">${m.sheet.map(p => `<figure><figcaption>${e(p.label)}</figcaption><div class="pair"><div><img src="${e(p.before)}" alt="before"><span>before</span></div><div><img src="${e(p.after)}" alt="after"><span>after</span></div></div></figure>`).join('')}</div>`
    } else if (this.views.length && run.state !== 'running') {
      sheet = `<p class="muted">No pictures this time. The editor shows the after: look at each place you changed.</p><ul class="looks">${this.views.map((v, i) => `<li><button data-act="look" data-i="${i}">Look</button> ${e(v.label)}${v.starred ? ' ★' : ''}</li>`).join('')}</ul>`
    }
    const disabled = (on: boolean) => (on ? '' : ' disabled')
    const test = `<button data-act="test"${disabled(m.testInGame.enabled)} title="${e(m.testInGame.why)}">Test in game</button>`
    const full = run.id && run.state !== 'running' ? '<button data-act="full" title="The same report as a page (a copy is kept on this PC for Claude)">Full report</button>' : ''
    const buttons = run.state === 'kept'
      ? `${full}<div class="grow"></div><button data-act="undo"${disabled(m.undo)} title="Put back the files this publish replaced (your edits stay)">Undo this publish</button><button data-act="close" class="primary">Close</button>`
      : run.state === 'discarded' || run.state === 'undone'
        ? `${full}<div class="grow"></div><button data-act="close" class="primary">Close</button>`
        : `${test}${full}<div class="grow"></div>` +
          `<button data-act="back"${disabled(m.goBack)} title="Throw this build away; your edits stay">Go back</button>` +
          `<button data-act="keep" class="primary"${disabled(m.keep.enabled)} title="${e(m.keep.why)}">Keep</button>`
    return `<div class="head"><h2>Publish${run.id ? ` <small>#${run.id}</small>` : ''}</h2><button data-act="close" class="x" title="Close (Publish… opens it again; nothing is thrown away)">×</button></div>
      <div class="verdict ${m.tone}"><b>${e(m.headline)}</b><div>${e(m.detail)}</div></div>
      <div class="body">
        ${steps}
        ${sec('What you changed', list(m.changes))}
        ${sec('Walking: what closed, and why', list(m.closed))}
        ${sec('The checks', checks)}
        ${sec('Budgets of the regions you changed', list(m.budgets))}
        ${sec('Also', list(m.notes))}
        ${sec('Tests', m.tests ? `<p>${e(m.tests)}</p>` : '')}
        ${sec('Before and after', sheet)}
      </div>
      <div class="foot">${buttons}</div>`
  }
}
