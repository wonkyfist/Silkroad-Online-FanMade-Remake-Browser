/**
 * The GM window's Toolbox tab: every one-click GM action (gm/toolbox-actions.ts) by group, with a search, favourites,
 * recent commands, a command line and autocomplete for player, item, monster and place names. Destructive or global
 * actions need a second click. Everything goes through the window's `run` (the server checks the role and audits).
 */
import type { ItemDef, MobDef } from '@sro/shared'
import { t } from '../i18n/index.ts'
import { gm, readPlayers, readPresets } from './commands.ts'
import {
  TOOL_ACTIONS,
  TOOL_GROUPS,
  actionLabel,
  buildAction,
  buildLine,
  groupLabel,
  matches,
  paramLabel,
  pushRecent,
  type ToolAction,
  type ToolGroup,
} from './toolbox-actions.ts'
import type { GmResultMsg, GmTab, GmTabApi } from './window.ts'

const STORE_KEY = 'sro.gm.toolbox'
const CONFIRM_MS = 4000
let seq = 0

interface Saved {
  fav: string[]
  recent: string[]
  group: string
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<Saved>
    return { fav: Array.isArray(v.fav) ? v.fav.filter((x) => typeof x === 'string') : [], recent: Array.isArray(v.recent) ? v.recent.filter((x) => typeof x === 'string') : [], group: typeof v.group === 'string' ? v.group : 'all' }
  } catch {
    return { fav: [], recent: [], group: 'all' }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

const CSS = `
.gm-tb { display: flex; flex-direction: column; gap: 4px; height: 100%; min-height: 0; font-size: 12px; }
.gm-tb-top { display: flex; gap: 4px; align-items: center; }
.gm-tb-top input { flex: 1; }
.gm-tb-groups { display: flex; flex-wrap: wrap; gap: 3px; }
.gm-tb-chip { cursor: pointer; padding: 1px 6px; border: 1px solid rgba(201,162,74,.45); border-radius: 3px; background: rgba(0,0,0,.35); color: var(--c-label, #e8d7a8); font-size: 11px; }
.gm-tb-chip.on { background: rgba(233,138,44,.35); color: #fff; }
.gm-tb-list { flex: 1; min-height: 60px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; padding-right: 2px; }
.gm-tb-act { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; padding: 3px 4px; background: rgba(255,220,140,.05); border-left: 2px solid rgba(201,162,74,.5); }
.gm-tb-act.danger { border-left-color: #c8473a; }
.gm-tb-name { flex: 1 0 100%; color: var(--c-label, #e8d7a8); display: flex; justify-content: space-between; }
.gm-tb-star { cursor: pointer; color: #8a7a55; background: none; border: none; padding: 0 2px; font-size: 13px; }
.gm-tb-star.on { color: #ffd953; }
.gm-tb-act input, .gm-tb-act select, .gm-tb-top input, .gm-tb-line input { background: rgba(0,0,0,.45); color: #eee; border: 1px solid rgba(201,162,74,.4); font-size: 11px; padding: 1px 3px; }
.gm-tb-act input { width: 86px; }
.gm-tb-act input.num { width: 52px; }
.gm-tb-act input.wide { width: 170px; }
.gm-tb-run { cursor: pointer; margin-left: auto; padding: 1px 10px; background: linear-gradient(#5b4a26,#3a2e15); color: #fff3cf; border: 1px solid #c9a24a; border-radius: 2px; font-size: 11px; }
.gm-tb-act.danger .gm-tb-run { background: linear-gradient(#6d2a22,#43170f); border-color: #c8473a; }
.gm-tb-run.armed { background: #c8473a !important; }
.gm-tb-line { display: flex; gap: 4px; }
.gm-tb-line input { flex: 1; }
.gm-tb-out { max-height: 90px; overflow-y: auto; white-space: pre-wrap; font: 11px/14px monospace; color: #ddd; background: rgba(0,0,0,.35); padding: 2px 4px; }
.gm-tb-out.bad { color: #ff8a7a; }
.gm-tb-hint { color: var(--c-hint, #b0b0b0); font-size: 10px; }
`

function injectCss(): void {
  if (document.getElementById('gm-toolbox-css')) return
  const s = el('style')
  s.id = 'gm-toolbox-css'
  s.textContent = CSS
  document.head.append(s)
}

export interface ToolboxContent {
  items(): Iterable<ItemDef>
  mobs(): Iterable<MobDef>
}

export class ToolboxTab implements GmTab {
  readonly root = el('div', 'gm-tb gm-ed')
  private readonly saved = load()
  private group: string
  private query = ''
  private readonly list = el('div', 'gm-tb-list')
  private readonly chips = el('div', 'gm-tb-groups')
  private readonly out = el('div', 'gm-tb-out')
  private readonly lists: Record<'player' | 'item' | 'mob' | 'place' | 'cmd', HTMLDataListElement>
  private readonly values = new Map<string, Record<string, string>>()
  private filled = false

  constructor(private readonly api: GmTabApi, private readonly content: ToolboxContent) {
    injectCss()
    this.group = this.saved.group
    const id = ++seq
    const dl = (k: string) => {
      const d = el('datalist')
      d.id = `gm-tb-${k}-${id}`
      return d
    }
    this.lists = { player: dl('player'), item: dl('item'), mob: dl('mob'), place: dl('place'), cmd: dl('cmd') }
    const search = el('input')
    search.placeholder = t('gm.tools.search')
    search.addEventListener('input', () => {
      this.query = search.value
      this.render()
    })
    const top = el('div', 'gm-tb-top')
    top.append(search)
    const line = el('input')
    line.placeholder = t('gm.tools.line')
    line.setAttribute('list', this.lists.cmd.id)
    line.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !line.value.trim()) return
      e.stopPropagation()
      if (this.send(buildLine(line.value), line.value.trim())) line.value = ''
    })
    const lineRow = el('div', 'gm-tb-line')
    lineRow.append(line)
    this.root.append(top, this.chips, this.list, lineRow, this.out, el('div', 'gm-tb-hint', t('gm.tools.hint')), ...Object.values(this.lists))
    // Typing in the panel never moves the character or fires hotkeys.
    this.root.addEventListener('keydown', (e) => e.stopPropagation())
    this.render()
  }

  show(): void {
    if (!this.filled) {
      this.filled = true
      this.fillContent()
      // the online players and the places for the autocomplete (also shown in the output)
      this.api.run(gm.who(), { chat: false, log: false })
      this.api.run(gm.places(), { chat: false, log: false })
      this.api.run(gm.help(), { chat: false, log: false })
    }
  }

  onResult(msg: GmResultMsg): void {
    const players = msg.cmd === 'who' ? readPlayers(msg.data) : null
    if (players) this.options(this.lists.player, players.map((p) => [p.name, `Lv ${p.level}`]))
    const presets = msg.cmd === 'tp' ? readPresets(msg.data) : null
    if (presets) this.options(this.lists.place, presets.map((p) => [p.name, p.group ?? '']))
    if (msg.cmd === 'help' && msg.data && typeof msg.data === 'object' && Array.isArray((msg.data as { commands?: unknown }).commands)) {
      const cmds = (msg.data as { commands: { name?: unknown; usage?: unknown }[] }).commands
      this.options(this.lists.cmd, cmds.filter((c) => typeof c.name === 'string').map((c) => [`/${c.name as string}`, typeof c.usage === 'string' ? c.usage : '']))
      return
    }
    if ((msg.cmd === 'who' && players) || (msg.cmd === 'tp' && presets)) return
    this.out.textContent = msg.message
    this.out.classList.toggle('bad', !msg.ok)
  }

  dispose(): void {
    this.root.remove()
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private fillContent(): void {
    const items: [string, string][] = [['gold', 'gold']]
    for (const i of this.content.items()) items.push([i.code, i.name ?? ''])
    this.options(this.lists.item, items)
    const mobs: [string, string][] = []
    for (const m of this.content.mobs()) mobs.push([m.code, `${m.name ?? ''} Lv ${m.level}`])
    this.options(this.lists.mob, mobs)
  }

  private options(list: HTMLDataListElement, rows: [string, string][]): void {
    list.replaceChildren(
      ...rows.map(([value, label]) => {
        const o = el('option')
        o.value = value
        if (label) o.label = label
        return o
      }),
    )
  }

  private persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ fav: this.saved.fav, recent: this.saved.recent, group: this.group }))
    } catch {
      // storage blocked: favourites and recent commands last this session only
    }
  }

  private send(build: ReturnType<typeof buildLine>, line: string): boolean {
    if (!build.ok) {
      this.api.setStatus(build.error, true)
      this.out.textContent = build.error
      this.out.classList.add('bad')
      return false
    }
    const sent = this.api.run(build)
    if (sent) {
      this.saved.recent = pushRecent(this.saved.recent, line)
      this.persist()
      if (this.group === 'recent') this.render()
    }
    return sent
  }

  private render(): void {
    const groups = ['all', 'fav', ...TOOL_GROUPS, 'recent'] as const
    this.chips.replaceChildren(
      ...groups.map((g) => {
        const c = el('span', `gm-tb-chip${this.group === g ? ' on' : ''}`, t(groupLabel(g)))
        c.addEventListener('click', () => {
          this.group = g
          this.persist()
          this.render()
        })
        return c
      }),
    )
    if (this.group === 'recent') {
      this.list.replaceChildren(
        ...this.saved.recent.map((line) => {
          const row = el('div', 'gm-tb-act')
          const name = el('span', 'gm-tb-name', line)
          const run = el('button', 'gm-tb-run', t('gm.tools.run'))
          run.addEventListener('click', () => this.send(buildLine(line), line))
          row.append(name, run)
          return row
        }),
      )
      if (this.saved.recent.length === 0) this.list.append(el('div', 'gm-tb-hint', t('gm.tools.empty')))
      return
    }
    const shown = TOOL_ACTIONS.filter((a) => {
      if (this.group === 'fav' && !this.saved.fav.includes(a.id)) return false
      if (this.group !== 'all' && this.group !== 'fav' && a.group !== (this.group as ToolGroup)) return false
      return matches(a, t(actionLabel(a.id)), this.query)
    })
    this.list.replaceChildren(...shown.map((a) => this.card(a)))
    if (shown.length === 0) this.list.append(el('div', 'gm-tb-hint', t('gm.tools.empty')))
  }

  private card(a: ToolAction): HTMLElement {
    const row = el('div', `gm-tb-act${a.confirm ? ' danger' : ''}`)
    const values = this.values.get(a.id) ?? {}
    this.values.set(a.id, values)
    const fav = this.saved.fav.includes(a.id)
    const star = el('button', `gm-tb-star${fav ? ' on' : ''}`, fav ? '★' : '☆')
    star.title = t(fav ? 'gm.tools.favOn' : 'gm.tools.favOff')
    star.addEventListener('click', () => {
      this.saved.fav = fav ? this.saved.fav.filter((x) => x !== a.id) : [...this.saved.fav, a.id]
      this.persist()
      this.render()
    })
    const name = el('div', 'gm-tb-name')
    name.append(el('span', '', t(actionLabel(a.id))), star)
    row.append(name)
    for (const p of a.params) {
      let field: HTMLInputElement | HTMLSelectElement
      if (p.kind === 'select') {
        const s = el('select')
        for (const o of p.options ?? []) s.append(Object.assign(el('option', '', o), { value: o }))
        s.value = values[p.key] ?? p.def ?? p.options?.[0] ?? ''
        field = s
      } else {
        const i = el('input', p.kind === 'number' ? 'num' : p.rest ? 'wide' : '')
        i.placeholder = t(paramLabel(p.key))
        i.value = values[p.key] ?? p.def ?? ''
        const list = p.kind === 'player' || p.kind === 'item' || p.kind === 'mob' || p.kind === 'place' ? this.lists[p.kind] : null
        if (list) i.setAttribute('list', list.id)
        i.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') run.click()
        })
        field = i
      }
      field.title = t(paramLabel(p.key))
      values[p.key] = field.value
      field.addEventListener('input', () => (values[p.key] = field.value))
      field.addEventListener('change', () => (values[p.key] = field.value))
      row.append(field)
    }
    const run = el('button', 'gm-tb-run', t('gm.tools.run'))
    let armed: ReturnType<typeof setTimeout> | null = null
    const disarm = () => {
      if (armed) clearTimeout(armed)
      armed = null
      run.classList.remove('armed')
      run.textContent = t('gm.tools.run')
    }
    run.addEventListener('click', () => {
      const v: Record<string, string> = { ...values }
      if (a.cursor) {
        const at = this.api.host.cursorGround()
        if (!at) return this.api.setStatus(t('gm.tools.noCursor'), true)
        v.x = String(Math.round(at.x * 10) / 10)
        v.z = String(Math.round(at.z * 10) / 10)
      }
      const build = buildAction(a, v, (key) => t('gm.tools.missing', { field: t(paramLabel(key)) }))
      if (!build.ok) return void this.send(build, '')
      if (a.confirm && !armed) {
        run.classList.add('armed')
        run.textContent = t('gm.tools.confirm')
        armed = setTimeout(disarm, CONFIRM_MS)
        return
      }
      disarm()
      this.send(build, `/${build.msg.cmd}${build.msg.args.length ? ` ${build.msg.args.join(' ')}` : ''}`)
    })
    row.append(run)
    return row
  }
}
