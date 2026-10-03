/**
 * The GM window's Spawns tab (docs/QUESTS.md §5.2; lane ED-C): the nests near the GM (`nest near`), a form to add a
 * nest at the GM's position or change the selected one, move / remove / restore / undo, and the live preview (ground
 * rings and labels, nest-rings.ts). While the tab shows, the list refreshes every 2 s for a while after an edit or a
 * move, else every 10 s (every refresh is an audited GM command, so the steady rate stays low).
 */
import type { GmNestInfo, MobDef } from '@sro/shared'
import { t } from '../../i18n/index.ts'
import { el } from '../../ui/dom.ts'
import type { GmBuild } from '../commands.ts'
import type { GmResultMsg, GmTab, GmTabApi } from '../window.ts'
import {
  AUTHORED_NEST_ID_MIN,
  NEST_ADD_DEFAULTS,
  NEST_NEAR_DEFAULT,
  dist2d,
  editorCmd,
  fmtRespawn,
  readNestResult,
  upsert,
  type NestField,
} from './commands.ts'
import type { NestRings } from './nest-rings.ts'
import { edButton, edCheck, edDatalist, edField, edLabel, edLine, edSection, edSmall, fillDatalist, fmtDist, srcLabel } from './ui.ts'

export interface SpawnsDeps {
  /** Monster rows of the content catalog (names and levels for the picker). */
  mobs(): ReadonlyMap<string, MobDef>
  /** The live preview (null: no 3D scene). Created by the feature, owned by this tab while it lives. */
  makeRings(): NestRings | null
  /** The GM's current target, if it is a monster: its code. */
  targetMob(): string | null
}

const FAST_MS = 2000
const SLOW_MS = 10_000
/** How long after an edit the list refreshes fast (the nest fills up). */
const FAST_FOR_MS = 14_000
/** Refresh when the GM moved this far from the last query point. */
const MOVE_REFRESH_M = 25
/** A near query without an answer is forgotten after this. */
const QUERY_TIMEOUT_MS = 5000

export class SpawnsTab implements GmTab {
  readonly root: HTMLElement
  private nests: GmNestInfo[] = []
  private selected: number | null = null
  private rings: NestRings | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private lastQuery = 0
  private lastPos: { x: number; z: number } | null = null
  private awaiting = 0
  private fastUntil = 0
  private shown = false
  private loadedMobs = false

  private readonly list: HTMLElement
  private readonly count: HTMLElement
  private readonly selText: HTMLElement
  private readonly mobList: HTMLDataListElement
  private readonly mob: HTMLInputElement
  private readonly countF: HTMLInputElement
  private readonly radius: HTMLInputElement
  private readonly spawnR: HTMLInputElement
  private readonly respawn: HTMLInputElement
  private readonly champion: HTMLInputElement
  private readonly aggressive: HTMLInputElement
  private readonly enabled: HTMLInputElement
  private readonly ringsBox: HTMLInputElement
  private readonly apply: HTMLButtonElement
  private readonly move: HTMLButtonElement
  private readonly remove: HTMLButtonElement
  private readonly restore: HTMLButtonElement

  constructor(
    private readonly api: GmTabApi,
    private readonly deps: SpawnsDeps,
  ) {
    const art = api.host.art
    // ---- list ----
    const refresh = edSmall(art, t('gm.editor.refresh'), 58)
    refresh.addEventListener('click', () => this.query(true))
    const undo = edSmall(art, t('gm.editor.undo'), 50, t('gm.editor.nest.undoHint'))
    undo.addEventListener('click', () => this.send(editorCmd.nestUndo()))
    this.count = el('span', 'gm-muted', t('gm.editor.loading'))
    const rings = edCheck(t('gm.editor.nest.rings'), t('gm.editor.nest.ringsHint'))
    this.ringsBox = rings.box
    this.ringsBox.checked = true
    this.ringsBox.addEventListener('change', () => this.rings?.setVisible(this.ringsBox.checked && this.shown))
    const head = el(
      'div',
      'gm-ed-row gm-ed-head',
      el('span', '', t('gm.editor.nest.colId')),
      el('span', '', t('gm.editor.nest.colMob')),
      el('span', '', t('gm.editor.nest.colCount')),
      el('span', '', t('gm.editor.colDist')),
      el('span', '', t('gm.editor.colSource')),
    )
    this.list = el('div', 'gm-list')
    this.selText = el('div', 'gm-ed-sel')

    // ---- form ----
    this.mobList = edDatalist('gm-ed-mobs')
    this.mob = edField('gm-ed-code', t('gm.editor.nest.mob'), 'MOB_CH_MANGNYANG')
    this.mob.setAttribute('list', this.mobList.id)
    const fromTarget = edSmall(art, t('gm.editor.target'), 54, t('gm.editor.nest.targetHint'))
    fromTarget.addEventListener('click', () => {
      const code = this.deps.targetMob()
      if (!code) return this.api.setStatus(t('gm.editor.nest.noTarget'), true)
      this.mob.value = code
    })
    this.countF = edField('gm-ed-short', t('gm.editor.nest.count'), String(NEST_ADD_DEFAULTS.count))
    this.radius = edField('gm-ed-short', t('gm.editor.nest.radius'), String(NEST_ADD_DEFAULTS.radius))
    this.spawnR = edField('gm-ed-short', t('gm.editor.nest.spawnRadius'))
    this.spawnR.placeholder = t('gm.editor.nest.sameAsRadius')
    this.respawn = edField('gm-ed-mid', t('gm.editor.nest.respawn'), String(NEST_ADD_DEFAULTS.respawnSec))
    this.respawn.title = t('gm.editor.nest.respawnHint')
    this.champion = edField('gm-ed-short', t('gm.editor.nest.champion'))
    this.champion.placeholder = '-'
    const aggressive = edCheck(t('gm.editor.nest.aggressive'))
    const enabled = edCheck(t('gm.editor.nest.enabled'))
    this.aggressive = aggressive.box
    this.enabled = enabled.box
    this.enabled.checked = true

    const addHere = edButton(art, t('gm.editor.nest.add'), 84, t('gm.editor.nest.addHint'))
    addHere.addEventListener('click', () => this.add())
    this.apply = edButton(art, t('gm.editor.apply'), 64, t('gm.editor.nest.applyHint'))
    this.apply.addEventListener('click', () => this.applyChanges())
    this.move = edButton(art, t('gm.editor.moveHere'), 80, t('gm.editor.nest.moveHint'))
    this.move.addEventListener('click', () => this.selected !== null && this.send(editorCmd.nestMove(this.selected)))
    this.remove = edButton(art, t('gm.editor.remove'), 64)
    this.remove.addEventListener('click', () => this.selected !== null && this.send(editorCmd.nestRemove(this.selected)))
    this.restore = edButton(art, t('gm.editor.restore'), 64, t('gm.editor.nest.restoreHint'))
    this.restore.addEventListener('click', () => this.selected !== null && this.send(editorCmd.nestRestore(this.selected)))
    for (const f of [this.mob, this.countF, this.radius, this.respawn]) {
      f.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') this.selected === null ? this.add() : this.applyChanges()
      })
    }

    this.root = el(
      'div',
      'gm-ed gm-ed-spawns',
      el('div', 'gm-bar', refresh, this.count, el('span', 'gm-right-fill'), rings.root, undo),
      head,
      this.list,
      this.selText,
      edSection(
        t('gm.editor.nest.form'),
        edLine(edLabel(t('gm.editor.nest.mob')), this.mob, fromTarget, edLabel(t('gm.editor.nest.count')), this.countF),
        edLine(edLabel(t('gm.editor.nest.radius')), this.radius, edLabel(t('gm.editor.nest.spawnRadius')), this.spawnR, edLabel(t('gm.editor.nest.respawn')), this.respawn),
        edLine(edLabel(t('gm.editor.nest.champion')), this.champion, aggressive.root, enabled.root),
        edLine(addHere, this.apply, this.move, this.remove, this.restore),
        el('div', 'gm-hint', t('gm.editor.nest.hint')),
        this.mobList,
      ),
    )
    const fill = this.root.querySelector<HTMLElement>('.gm-right-fill')
    if (fill) fill.style.flex = '1'
    this.renderList()
    this.syncButtons()
  }

  // ---- GmTab ---------------------------------------------------------------------------------------------

  show(): void {
    this.shown = true
    if (!this.loadedMobs) this.loadMobs()
    this.rings ??= this.deps.makeRings()
    this.rings?.setVisible(this.ringsBox.checked)
    this.rings?.set(this.nests)
    this.rings?.select(this.selected)
    this.query(false)
    clearInterval(this.timer)
    this.timer = setInterval(() => this.tick(), 500)
  }

  hide(): void {
    this.shown = false
    clearInterval(this.timer)
    this.timer = undefined
    this.rings?.setVisible(false)
  }

  onResult(msg: GmResultMsg): void {
    if (msg.cmd !== 'nest') return
    const r = readNestResult(msg.data)
    if (!msg.ok) {
      // A failed query ("needs your character in the world") must not block the next one.
      if (this.awaiting && /\bnest near\b/i.test(msg.message)) this.awaiting = 0
      return
    }
    if (r.nests) {
      this.awaiting = 0
      this.nests = r.nests
      if (this.selected !== null && !this.nests.some(n => n.id === this.selected)) this.selected = null
      this.count.textContent = t('gm.editor.nest.count.list', { n: r.nests.length, r: NEST_NEAR_DEFAULT })
    }
    if (r.nest) {
      const n = r.nest
      this.nests = upsert(this.nests, x => x.id, n.id, n)
      this.select(n.id, true)
      this.fast()
    }
    if (r.removed !== undefined) {
      this.nests = upsert(this.nests, x => x.id, r.removed, null)
      if (this.selected === r.removed) this.selected = null
      this.fast()
    }
    if (r.rev !== undefined) {
      this.fast()
      this.query(true)
    }
    this.renderList()
    this.rings?.set(this.nests)
    this.rings?.select(this.selected)
    this.syncButtons()
  }

  /** Another GM (or a reload) changed the spawn overrides. */
  contentChanged(): void {
    if (this.shown) this.query(true)
  }

  /** Every frame (labels follow the camera). */
  frame(): void {
    if (this.shown) this.rings?.frame()
  }

  dispose(): void {
    this.hide()
    this.rings?.dispose()
    this.rings = null
  }

  // ---- queries -------------------------------------------------------------------------------------------

  private send(build: GmBuild): boolean {
    return this.api.run(build)
  }

  private query(force: boolean): void {
    const now = Date.now()
    if (!force && this.awaiting && now - this.awaiting < QUERY_TIMEOUT_MS) return
    if (this.api.run(editorCmd.nestNear(), { chat: false, log: false })) {
      this.awaiting = now
      this.lastQuery = now
      this.lastPos = this.api.host.selfPos()
    }
  }

  private fast(): void {
    this.fastUntil = Date.now() + FAST_FOR_MS
  }

  private tick(): void {
    if (!this.api.isShown()) return
    const now = Date.now()
    const pos = this.api.host.selfPos()
    const moved = pos && this.lastPos ? dist2d(pos, this.lastPos) > MOVE_REFRESH_M : false
    const every = now < this.fastUntil ? FAST_MS : SLOW_MS
    if (moved || now - this.lastQuery >= every) this.query(false)
    // distances change as the GM walks
    if (pos) this.updateDistances(pos)
  }

  // ---- actions -------------------------------------------------------------------------------------------

  private add(): void {
    if (this.send(editorCmd.nestAdd(this.mob.value, this.countF.value, this.radius.value, this.respawn.value))) this.fast()
  }

  /** Sends one `nest set` per field that differs from the selected nest. */
  private applyChanges(): void {
    const n = this.nests.find(x => x.id === this.selected)
    if (!n) return this.api.setStatus(t('gm.editor.nest.selectFirst'), true)
    const sets: [NestField, string | boolean][] = []
    if (this.mob.value.trim().toUpperCase() !== n.mob) sets.push(['mob', this.mob.value])
    if (this.countF.value.trim() !== String(n.count)) sets.push(['count', this.countF.value])
    if (this.radius.value.trim() !== String(n.radius)) sets.push(['radius', this.radius.value])
    if (this.spawnR.value.trim() !== '' && this.spawnR.value.trim() !== String(n.spawnRadius)) sets.push(['spawnradius', this.spawnR.value])
    if (this.respawn.value.replace(/\s+/g, '') !== fmtRespawn(n.respawnSec)) sets.push(['respawn', this.respawn.value])
    if (this.champion.value.trim() !== '') sets.push(['champion', this.champion.value])
    if (this.aggressive.checked !== n.aggressive) sets.push(['aggressive', this.aggressive.checked])
    if (this.enabled.checked !== n.enabled) sets.push(['enabled', this.enabled.checked])
    if (!sets.length) return this.api.setStatus(t('gm.editor.noChanges'))
    // Check every field first: nothing is sent when one is out of bounds.
    const builds = sets.map(([f, v]) => editorCmd.nestSet(n.id, f, v))
    const bad = builds.find(b => !b.ok)
    if (bad && !bad.ok) return this.api.setStatus(bad.error, true)
    for (const b of builds) this.send(b)
    this.champion.value = ''
    this.fast()
  }

  // ---- view ----------------------------------------------------------------------------------------------

  private select(id: number | null, fillForm: boolean): void {
    this.selected = id
    const n = this.nests.find(x => x.id === id)
    if (n && fillForm) {
      this.mob.value = n.mob
      this.countF.value = String(n.count)
      this.radius.value = String(n.radius)
      this.spawnR.value = String(n.spawnRadius)
      this.respawn.value = fmtRespawn(n.respawnSec)
      this.champion.value = ''
      this.aggressive.checked = n.aggressive
      this.enabled.checked = n.enabled
    }
    for (const row of this.list.querySelectorAll<HTMLElement>('.gm-ed-row')) row.classList.toggle('selected', row.dataset.id === String(id))
    this.rings?.select(id)
    this.syncButtons()
  }

  private syncButtons(): void {
    const n = this.nests.find(x => x.id === this.selected)
    this.apply.disabled = this.move.disabled = this.remove.disabled = !n
    this.restore.disabled = !n || n.id >= AUTHORED_NEST_ID_MIN || n.source === 'export'
    this.selText.textContent = n
      ? t('gm.editor.nest.selected', {
          id: n.id,
          mob: n.mobName,
          level: n.level,
          radius: n.radius,
          spawn: n.spawnRadius,
          respawn: fmtRespawn(n.respawnSec),
          mode: n.aggressive ? t('gm.editor.nest.aggressive') : t('gm.editor.nest.passive'),
          x: Math.round(n.x),
          z: Math.round(n.z),
        })
      : t('gm.editor.nest.none')
  }

  private renderList(): void {
    this.list.replaceChildren()
    if (!this.nests.length) {
      this.list.append(el('div', 'gm-empty', this.lastQuery ? t('gm.editor.nest.empty') : t('gm.editor.loading')))
      return
    }
    const pos = this.api.host.selfPos()
    for (const n of this.nests) {
      const src = n.enabled ? n.source : 'disabled'
      const row = el(
        'div',
        `gm-ed-row${n.id === this.selected ? ' selected' : ''}${n.enabled ? '' : ' off'}`,
        el('span', 'gm-muted', `#${n.id}`),
        el('span', '', `${n.mobName} `, el('span', 'gm-muted', `Lv ${n.level}`)),
        el('span', '', `x${n.count} (${n.alive})`),
        el('span', 'gm-muted gm-ed-dist', pos ? fmtDist(dist2d(pos, n)) : ''),
        el('span', `gm-ed-src ${src}`, srcLabel(src)),
      )
      row.dataset.id = String(n.id)
      row.title = `${n.mob} r${n.radius}/${n.spawnRadius} ${fmtRespawn(n.respawnSec)}s`
      row.addEventListener('click', () => this.select(n.id, true))
      this.list.append(row)
    }
  }

  private updateDistances(pos: { x: number; z: number }): void {
    for (const row of this.list.querySelectorAll<HTMLElement>('.gm-ed-row')) {
      const n = this.nests.find(x => String(x.id) === row.dataset.id)
      const cell = row.querySelector('.gm-ed-dist')
      if (n && cell) cell.textContent = fmtDist(dist2d(pos, n))
    }
  }

  private loadMobs(): void {
    const mobs = [...this.deps.mobs().values()].filter(m => /^MOB_/.test(m.code))
    if (!mobs.length) return
    this.loadedMobs = true
    mobs.sort((a, b) => a.level - b.level || a.code.localeCompare(b.code))
    fillDatalist(
      this.mobList,
      mobs.slice(0, 2000).map(m => [m.code, `${m.name ?? m.code} (Lv ${m.level})`] as [string, string]),
    )
  }
}
