/**
 * The GM window's NPCs tab (docs/QUESTS.md §5.3; lane ED-C): the NPCs near the GM (`npc near`), placing a new NPC
 * (`NPCX_<n>` wearing a base NPC's look) at the GM's position and facing, and renaming / shop / move / face / remove /
 * restore / undo for the selected one. The list refreshes on show, after an edit and when the GM has walked away.
 */
import type { GmNpcInfo, NpcDef, ShopDef } from '@sro/shared'
import { t } from '../../i18n/index.ts'
import { el } from '../../ui/dom.ts'
import type { GmBuild } from '../commands.ts'
import type { GmResultMsg, GmTab, GmTabApi } from '../window.ts'
import { NPC_NEAR_DEFAULT, dist2d, editorCmd, readNpcResult, upsert } from './commands.ts'
import { edButton, edDatalist, edField, edLabel, edLine, edSection, edSmall, fillDatalist, fmtDist, srcLabel } from './ui.ts'

export interface NpcsDeps {
  /** NPC rows of the content catalog (the base look picker). */
  npcs(): ReadonlyMap<string, NpcDef>
  shops(): ReadonlyMap<string, ShopDef>
  /** The NPC identity (`state.npc ?? state.model`) of the GM's target, when it is an NPC. */
  targetNpc(): string | null
}

const MOVE_REFRESH_M = 20
const QUERY_TIMEOUT_MS = 5000

export class NpcsTab implements GmTab {
  readonly root: HTMLElement
  private npcs: GmNpcInfo[] = []
  private selected: string | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private lastPos: { x: number; z: number } | null = null
  private lastQuery = 0
  private awaiting = 0
  private shown = false
  private loaded = false

  private readonly list: HTMLElement
  private readonly count: HTMLElement
  private readonly selText: HTMLElement
  private readonly baseList: HTMLDataListElement
  private readonly shopList: HTMLDataListElement
  private readonly base: HTMLInputElement
  private readonly newName: HTMLInputElement
  private readonly name: HTMLInputElement
  private readonly shop: HTMLInputElement
  private readonly selButtons: HTMLButtonElement[]
  private readonly restore: HTMLButtonElement

  constructor(
    private readonly api: GmTabApi,
    private readonly deps: NpcsDeps,
  ) {
    const art = api.host.art
    const refresh = edSmall(art, t('gm.editor.refresh'), 58)
    refresh.addEventListener('click', () => this.query(true))
    const pick = edSmall(art, t('gm.editor.target'), 54, t('gm.editor.npc.pickHint'))
    pick.addEventListener('click', () => this.pickTarget())
    const undo = edSmall(art, t('gm.editor.undo'), 50, t('gm.editor.npc.undoHint'))
    undo.addEventListener('click', () => this.send(editorCmd.npcUndo()))
    this.count = el('span', 'gm-muted', t('gm.editor.loading'))
    const fill = el('span', '')
    fill.style.flex = '1'
    const head = el('div', 'gm-ed-row gm-ed-npc gm-ed-head', el('span', '', t('gm.editor.npc.colCode')), el('span', '', t('gm.editor.npc.colName')), el('span', '', t('gm.editor.colDist')), el('span', '', t('gm.editor.colSource')))
    this.list = el('div', 'gm-list')
    this.selText = el('div', 'gm-ed-sel')

    // ---- new NPC ----
    this.baseList = edDatalist('gm-ed-npcs')
    this.base = edField('gm-ed-code', t('gm.editor.npc.base'), 'NPC_CH_SMITH')
    this.base.setAttribute('list', this.baseList.id)
    const baseTarget = edSmall(art, t('gm.editor.target'), 54, t('gm.editor.npc.baseTargetHint'))
    baseTarget.addEventListener('click', () => {
      const code = this.deps.targetNpc()
      if (!code) return this.api.setStatus(t('gm.editor.npc.noTarget'), true)
      const row = this.npcs.find(n => n.code === code)
      this.base.value = row?.base ?? code
    })
    this.newName = edField('gm-ed-name', t('gm.editor.npc.name'))
    this.newName.maxLength = 64
    this.newName.placeholder = t('gm.editor.npc.namePlaceholder')
    const add = edButton(art, t('gm.editor.npc.add'), 84, t('gm.editor.npc.addHint'))
    const doAdd = () => this.send(editorCmd.npcAdd(this.base.value, this.newName.value))
    add.addEventListener('click', doAdd)
    for (const f of [this.base, this.newName]) f.addEventListener('keydown', ev => ev.key === 'Enter' && doAdd())

    // ---- selected NPC ----
    this.name = edField('gm-ed-name', t('gm.editor.npc.name'))
    this.name.maxLength = 64
    const rename = edSmall(art, t('gm.editor.npc.rename'), 60)
    rename.addEventListener('click', () => this.selected && this.send(editorCmd.npcRename(this.selected, this.name.value)))
    this.name.addEventListener('keydown', ev => ev.key === 'Enter' && this.selected && this.send(editorCmd.npcRename(this.selected, this.name.value)))
    this.shopList = edDatalist('gm-ed-shops')
    this.shop = edField('gm-ed-code', t('gm.editor.npc.shop'))
    this.shop.setAttribute('list', this.shopList.id)
    this.shop.placeholder = t('gm.editor.npc.noShop')
    const setShop = edSmall(art, t('gm.editor.npc.setShop'), 60)
    setShop.addEventListener('click', () => this.selected && this.send(editorCmd.npcShop(this.selected, this.shop.value)))
    const noShop = edSmall(art, t('gm.editor.npc.clearShop'), 60)
    noShop.addEventListener('click', () => this.selected && this.send(editorCmd.npcShop(this.selected, null)))
    const move = edButton(art, t('gm.editor.moveHere'), 80, t('gm.editor.npc.moveHint'))
    move.addEventListener('click', () => this.selected && this.send(editorCmd.npcMove(this.selected)))
    const face = edButton(art, t('gm.editor.npc.face'), 88, t('gm.editor.npc.faceHint'))
    face.addEventListener('click', () => this.selected && this.send(editorCmd.npcFace(this.selected)))
    const remove = edButton(art, t('gm.editor.remove'), 64, t('gm.editor.npc.removeHint'))
    remove.addEventListener('click', () => this.selected && this.send(editorCmd.npcRemove(this.selected)))
    this.restore = edButton(art, t('gm.editor.restore'), 64, t('gm.editor.npc.restoreHint'))
    this.restore.addEventListener('click', () => this.selected && this.send(editorCmd.npcRestore(this.selected)))
    this.selButtons = [rename, setShop, noShop, move, face, remove]

    this.root = el(
      'div',
      'gm-ed gm-ed-npcs',
      el('div', 'gm-bar', refresh, this.count, fill, pick, undo),
      head,
      this.list,
      this.selText,
      edSection(
        t('gm.editor.npc.selectedTitle'),
        edLine(edLabel(t('gm.editor.npc.name')), this.name, rename),
        edLine(edLabel(t('gm.editor.npc.shop')), this.shop, setShop, noShop),
        edLine(move, face, remove, this.restore),
        this.shopList,
      ),
      edSection(t('gm.editor.npc.newTitle'), edLine(edLabel(t('gm.editor.npc.base')), this.base, baseTarget), edLine(edLabel(t('gm.editor.npc.name')), this.newName, add), el('div', 'gm-hint', t('gm.editor.npc.hint')), this.baseList),
    )
    this.renderList()
    this.syncSelected()
  }

  show(): void {
    this.shown = true
    if (!this.loaded) this.loadCatalog()
    this.query(false)
    clearInterval(this.timer)
    this.timer = setInterval(() => this.tick(), 1000)
  }

  hide(): void {
    this.shown = false
    clearInterval(this.timer)
    this.timer = undefined
  }

  onResult(msg: GmResultMsg): void {
    if (msg.cmd !== 'npc') return
    if (!msg.ok) {
      if (this.awaiting && /\bnpc near\b/i.test(msg.message)) this.awaiting = 0
      return
    }
    const r = readNpcResult(msg.data)
    if (r.npcs) {
      this.awaiting = 0
      this.npcs = r.npcs
      this.count.textContent = t('gm.editor.npc.count.list', { n: r.npcs.length, r: NPC_NEAR_DEFAULT })
      if (this.selected && !this.npcs.some(n => n.code === this.selected)) this.selected = null
    }
    if (r.npc) {
      this.npcs = upsert(this.npcs, n => n.code, r.npc.code, r.npc)
      this.select(r.npc.code, true)
    }
    if (r.removed !== undefined && !r.npc) {
      // Authored: gone. Exported: now hidden (the next list shows it so).
      const was = this.npcs.find(n => n.code === r.removed)
      if (was && was.source !== 'authored') this.npcs = upsert(this.npcs, n => n.code, was.code, { ...was, hidden: true, entity: null })
      else this.npcs = upsert(this.npcs, n => n.code, r.removed, null)
      if (this.selected === r.removed && !this.npcs.some(n => n.code === r.removed)) this.selected = null
      this.query(true)
    }
    if (r.rev !== undefined) this.query(true)
    this.renderList()
    this.syncSelected()
  }

  contentChanged(): void {
    if (this.shown) this.query(true)
  }

  dispose(): void {
    this.hide()
  }

  private send(build: GmBuild): boolean {
    return this.api.run(build)
  }

  private query(force: boolean): void {
    const now = Date.now()
    if (!force && this.awaiting && now - this.awaiting < QUERY_TIMEOUT_MS) return
    if (this.api.run(editorCmd.npcNear(), { chat: false, log: false })) {
      this.awaiting = now
      this.lastQuery = now
      this.lastPos = this.api.host.selfPos()
    }
  }

  private tick(): void {
    if (!this.api.isShown()) return
    const pos = this.api.host.selfPos()
    if (pos && this.lastPos && dist2d(pos, this.lastPos) > MOVE_REFRESH_M) this.query(false)
    if (pos) {
      for (const row of this.list.querySelectorAll<HTMLElement>('.gm-ed-row')) {
        const n = this.npcs.find(x => x.code === row.dataset.code)
        const cell = row.querySelector('.gm-ed-dist')
        if (n && cell) cell.textContent = fmtDist(dist2d(pos, n))
      }
    }
  }

  /** Selects the NPC the GM is targeting (asks the server for the list around it first if needed). */
  private pickTarget(): void {
    const code = this.deps.targetNpc()
    if (!code) return this.api.setStatus(t('gm.editor.npc.noTarget'), true)
    if (this.npcs.some(n => n.code === code)) this.select(code, true)
    else this.api.setStatus(t('gm.editor.npc.notListed', { code }), true)
  }

  private select(code: string | null, fill: boolean): void {
    this.selected = code
    const n = this.npcs.find(x => x.code === code)
    if (n && fill) {
      this.name.value = n.name
      this.shop.value = n.shop ?? ''
    }
    for (const row of this.list.querySelectorAll<HTMLElement>('.gm-ed-row')) row.classList.toggle('selected', row.dataset.code === code)
    this.syncSelected()
  }

  private syncSelected(): void {
    const n = this.npcs.find(x => x.code === this.selected)
    for (const b of this.selButtons) b.disabled = !n || n.hidden === true
    this.restore.disabled = !n || n.source === 'authored' || (n.source === 'export' && !n.hidden)
    if (!n) {
      this.selText.textContent = t('gm.editor.npc.none')
      return
    }
    const look = n.base !== n.code ? t('gm.editor.npc.looksLike', { base: n.base }) : ''
    const shop = n.shop ? t('gm.editor.npc.withShop', { shop: n.shop }) : ''
    const state = n.hidden ? t('gm.editor.npc.hidden') : n.entity === null ? t('gm.editor.npc.unplaced') : ''
    this.selText.textContent = `${n.code} "${n.name}"${look}${shop} @ ${Math.round(n.x)}, ${Math.round(n.z)}${state}`
  }

  private renderList(): void {
    this.list.replaceChildren()
    if (!this.npcs.length) {
      this.list.append(el('div', 'gm-empty', this.lastQuery ? t('gm.editor.npc.empty') : t('gm.editor.loading')))
      return
    }
    const pos = this.api.host.selfPos()
    for (const n of this.npcs) {
      const src = n.hidden ? 'hidden' : n.source
      const row = el(
        'div',
        `gm-ed-row gm-ed-npc${n.code === this.selected ? ' selected' : ''}${n.hidden ? ' off' : ''}`,
        el('span', n.source === 'authored' ? '' : 'gm-muted', n.code),
        el('span', '', n.name, n.base !== n.code ? el('span', 'gm-muted', ` (${n.base})`) : null),
        el('span', 'gm-muted gm-ed-dist', pos ? fmtDist(dist2d(pos, n)) : ''),
        el('span', `gm-ed-src ${src}`, srcLabel(src)),
      )
      row.dataset.code = n.code
      row.title = `${n.code}${n.shop ? ` / ${n.shop}` : ''}`
      row.addEventListener('click', () => this.select(n.code, true))
      this.list.append(row)
    }
  }

  private loadCatalog(): void {
    const npcs = [...this.deps.npcs().values()].filter(n => /^NPC_/.test(n.code))
    if (!npcs.length) return
    this.loaded = true
    npcs.sort((a, b) => a.code.localeCompare(b.code))
    const seen = new Set<string>()
    fillDatalist(
      this.baseList,
      npcs.filter(n => !seen.has(n.code) && seen.add(n.code)).map(n => [n.code, n.name ?? n.code] as [string, string]),
    )
    fillDatalist(
      this.shopList,
      [...this.deps.shops().values()].map(s => [s.id, s.npcs.join(', ')] as [string, string]),
    )
  }
}
