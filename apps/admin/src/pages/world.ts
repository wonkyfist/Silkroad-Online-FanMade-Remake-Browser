import type { AdminMobRow, AdminNestRow, AdminNpcRow, AdminPage } from '@sro/shared'
import { get, post, qs } from '../api.ts'
import { attempt, badge, button, card, confirmDialog, dataTable, formDialog, h, icon, pageHeader, tabs, toast, type TableHandle } from '../ui.ts'

/**
 * NPCs and monster spawns (docs/ADMIN.md §1): the GM editors' own logic (override files in DATA_DIR/content, history,
 * live application), with world coordinates typed in. Coordinates are metres as GM /where shows them.
 */
export function worldPage(root: HTMLElement): void {
  root.append(
    pageHeader('NPCs & spawns', 'Edits apply live and land in DATA_DIR/content (nests.override.json, npcs.override.json); undo walks back the history.'),
    tabs([
      { id: 'nests', label: 'Monster spawns', render: nestsTab },
      { id: 'npcs', label: 'NPCs', render: npcsTab },
    ]),
  )
}

type Result = { message: string; data: unknown }

const mobSuggest = async (q: string) =>
  q.length < 2 ? [] : (await get<AdminPage<AdminMobRow>>(`mobs${qs({ q, size: 20 })}`)).rows.map((m) => ({ value: m.code, label: `${m.name ?? m.code} (Lv ${m.level}${m.rarity !== 'normal' ? `, ${m.rarity}` : ''})`, icon: m.icon }))

const deg = (rad: number) => Math.round((rad * 180) / Math.PI)
const rad = (d: number) => Math.round(((d * Math.PI) / 180) * 1000) / 1000

function nestsTab(root: HTMLElement): void {
  const source = h('select', { class: 'input', 'aria-label': 'Source' }, [['', 'All nests'], ['authored', 'Authored'], ['patched', 'Patched'], ['export', 'Exported'], ['removed', 'Removed']].map(([v, l]) => h('option', { value: v }, l)))
  let table: TableHandle
  const run = async (fn: () => Promise<Result>) => {
    const r = await attempt(fn)
    if (r) {
      void table.reload()
      return r
    }
    return undefined
  }
  const done = (r: Result | undefined) => r && toastMsg(r)
  table = dataTable<AdminNestRow>({
    placeholder: 'Search by monster or nest id',
    filters: [source],
    size: 50,
    load: (q, page, size) => get<AdminPage<AdminNestRow>>(`nests${qs({ q, page, size, source: source.value })}`),
    columns: [
      { label: '#', render: (n) => h('span', { class: 'mono small' }, String(n.id)) },
      { label: 'Monster', primary: true, render: (n) => h('span', { class: 'item nowrap' }, icon(n.icon, n.mobName), h('strong', null, n.mobName), h('span', { class: 'dim small' }, `Lv ${n.level}`)) },
      { label: 'Count', render: (n) => `${n.alive} / ${n.count}`, class: 'num' },
      { label: 'Radius', render: (n) => `${n.radius} m`, class: 'num' },
      { label: 'Respawn', class: 'nowrap', render: (n) => (n.respawnSec[0] === n.respawnSec[1] ? `${n.respawnSec[0]} s` : `${n.respawnSec[0]}–${n.respawnSec[1]} s`) },
      { label: 'At', class: 'nowrap', render: (n) => h('span', { class: 'small' }, `${n.x}, ${n.z}`) },
      {
        label: 'Flags',
        render: (n) => [
          n.removed ? badge('removed', 'bad') : badge(n.source, n.source === 'export' ? 'dim' : 'gold'),
          !n.enabled ? badge('disabled', 'bad') : null,
          n.aggressive ? badge('aggressive', 'info') : null,
        ],
      },
      {
        label: '',
        class: 'row-actions',
        render: (n) =>
          n.removed
            ? [button('Restore', () => void run(() => post<Result>(`nests/${n.id}/restore`)).then(done), 'small')]
            : [
                button('Edit…', () => void editNest(n).then((r) => r && (toastMsg(r), table.reload())), 'small'),
                button('Move…', () => void moveNest(n).then((r) => r && (toastMsg(r), table.reload())), 'small'),
                n.source === 'patched' ? button('Restore', () => void run(() => post<Result>(`nests/${n.id}/restore`)).then(done), 'small') : null,
                button('Remove…', async () => {
                  if (await confirmDialog({ title: 'Remove nest', message: `Remove nest #${n.id} (${n.mobName} ×${n.count})? Its monsters despawn.${n.source === 'authored' ? '' : ' The exported nest is hidden by the override (Restore brings it back).'}`, confirm: 'Remove', danger: true })) done(await run(() => post<Result>(`nests/${n.id}/remove`)))
                }, 'small'),
              ],
      },
    ],
  })
  source.addEventListener('change', () => void table.reload())
  const add = button('Add nest…', async () => {
    let r: Result | undefined
    const v = await formDialog({
      title: 'Add a monster nest',
      fields: [
        { name: 'mob', label: 'Monster code', required: true, suggest: mobSuggest, placeholder: 'MOB_CH_MANGNYANG' },
        { name: 'x', label: 'X (m)', type: 'number', required: true, step: 'any' },
        { name: 'z', label: 'Z (m)', type: 'number', required: true, step: 'any', hint: 'GM /where shows your position.' },
        { name: 'count', label: 'Count (1-50)', type: 'number', value: 5, min: 1, max: 50 },
        { name: 'radius', label: 'Radius (m, 2-200)', type: 'number', value: 30, min: 2, max: 200 },
        { name: 'rmin', label: 'Respawn min (s)', type: 'number', value: 30, min: 1 },
        { name: 'rmax', label: 'Respawn max (s)', type: 'number', value: 30, min: 1 },
      ],
      submit: 'Add',
      onSubmit: async (x) => {
        r = await post<Result>('nests', { mob: String(x.mob).trim(), x: x.x, z: x.z, count: x.count, radius: x.radius, respawnSec: [x.rmin, x.rmax] })
      },
    })
    if (v && r) {
      toastMsg(r)
      void table.reload()
    }
  }, 'primary')
  const undo = button('Undo last change', async () => {
    if (await confirmDialog({ title: 'Undo', message: 'Put the spawn overrides back to their previous version?', confirm: 'Undo' })) done(await run(() => post<Result>('nests/undo')))
  })
  root.append(card(null, h('div', { class: 'actions card-actions' }, add, undo), table.root))
}

async function editNest(n: AdminNestRow): Promise<Result | undefined> {
  let r: Result | undefined
  await formDialog({
    title: `Nest #${n.id}: ${n.mobName}`,
    fields: [
      { name: 'mob', label: 'Monster code', value: n.mob, suggest: mobSuggest },
      { name: 'count', label: 'Count (1-50)', type: 'number', value: n.count, min: 1, max: 50 },
      { name: 'radius', label: 'Roam radius (m)', type: 'number', value: n.radius, min: 2, max: 200 },
      { name: 'spawnRadius', label: 'Spawn radius (m)', type: 'number', value: n.spawnRadius, min: 0, max: 200 },
      { name: 'rmin', label: 'Respawn min (s)', type: 'number', value: n.respawnSec[0], min: 1 },
      { name: 'rmax', label: 'Respawn max (s)', type: 'number', value: n.respawnSec[1], min: 1 },
      { name: 'aggressive', label: 'Aggressive', type: 'checkbox', value: n.aggressive },
      { name: 'enabled', label: 'Enabled', type: 'checkbox', value: n.enabled },
    ],
    onSubmit: async (x) => {
      const body: Record<string, unknown> = {}
      if (String(x.mob).trim().toUpperCase() !== n.mob) body.mob = String(x.mob).trim()
      if (x.count !== n.count) body.count = x.count
      if (x.radius !== n.radius) body.radius = x.radius
      if (x.spawnRadius !== n.spawnRadius) body.spawnRadius = x.spawnRadius
      if (x.rmin !== n.respawnSec[0] || x.rmax !== n.respawnSec[1]) body.respawnSec = [x.rmin, x.rmax]
      if (x.aggressive !== n.aggressive) body.aggressive = x.aggressive
      if (x.enabled !== n.enabled) body.enabled = x.enabled
      if (Object.keys(body).length === 0) return
      r = await post<Result>(`nests/${n.id}`, body)
    },
  })
  return r
}

async function moveNest(n: AdminNestRow): Promise<Result | undefined> {
  let r: Result | undefined
  await formDialog({
    title: `Move nest #${n.id}`,
    fields: [
      { name: 'x', label: 'X (m)', type: 'number', value: n.x, step: 'any', required: true },
      { name: 'z', label: 'Z (m)', type: 'number', value: n.z, step: 'any', required: true },
    ],
    submit: 'Move',
    onSubmit: async (x) => {
      r = await post<Result>(`nests/${n.id}/move`, { x: x.x, z: x.z })
    },
  })
  return r
}

function toastMsg(r: Result): void {
  toast(r.message.split('\n')[0], 'ok')
}

function npcsTab(root: HTMLElement): void {
  let table: TableHandle
  let shops: { id: string }[] = []
  void get<{ shops: { id: string }[] }>('shops').then((r) => (shops = r.shops)).catch(() => {})
  const refresh = (r: Result | undefined) => {
    if (r) {
      toastMsg(r)
      void table.reload()
    }
  }
  table = dataTable<AdminNpcRow>({
    placeholder: 'Search by name, code or shop',
    load: (q, page, size) => get<AdminPage<AdminNpcRow>>(`npcs${qs({ q, page, size })}`),
    columns: [
      { label: 'NPC', render: (n) => [h('strong', null, n.name), n.base !== n.code ? h('span', { class: 'dim small' }, ` looks like ${n.base}`) : null] },
      { label: 'Code', render: (n) => h('span', { class: 'mono dim small' }, n.code) },
      { label: 'Shop', render: (n) => n.shop ?? '–' },
      { label: 'At', class: 'nowrap', render: (n) => h('span', { class: 'small' }, `${n.x}, ${n.z} · ${deg(n.yaw)}°`) },
      { label: 'Flags', render: (n) => [badge(n.source, n.source === 'export' ? 'dim' : 'gold'), n.hidden ? badge('removed', 'bad') : null, n.entity === null && !n.hidden ? badge('not placed', 'bad') : null] },
      {
        label: '',
        class: 'row-actions',
        render: (n) =>
          n.hidden
            ? [button('Restore', async () => refresh(await attempt(() => post<Result>(`npcs/${encodeURIComponent(n.code)}/restore`))), 'small')]
            : [
                button('Edit…', async () => {
                  let r: Result | undefined
                  await formDialog({
                    title: `${n.name} (${n.code})`,
                    fields: [
                      { name: 'name', label: 'Name', value: n.name, maxlength: 32, required: true },
                      { name: 'shop', label: 'Shop', type: 'select', value: n.shop ?? '', options: [{ value: '', label: 'No shop' }, ...shops.map((s) => ({ value: s.id, label: s.id }))] },
                    ],
                    onSubmit: async (x) => {
                      const body: Record<string, unknown> = {}
                      if (String(x.name).trim() !== n.name) body.name = String(x.name).trim()
                      if ((x.shop || null) !== (n.shop ?? null)) body.shop = x.shop || null
                      if (Object.keys(body).length) r = await post<Result>(`npcs/${encodeURIComponent(n.code)}`, body)
                    },
                  })
                  refresh(r)
                }, 'small'),
                button('Move…', async () => {
                  let r: Result | undefined
                  await formDialog({
                    title: `Move ${n.name}`,
                    fields: [
                      { name: 'x', label: 'X (m)', type: 'number', value: n.x, step: 'any', required: true },
                      { name: 'z', label: 'Z (m)', type: 'number', value: n.z, step: 'any', required: true },
                      { name: 'yaw', label: 'Facing (degrees)', type: 'number', value: deg(n.yaw), step: 'any' },
                    ],
                    submit: 'Move',
                    onSubmit: async (x) => {
                      r = await post<Result>(`npcs/${encodeURIComponent(n.code)}/move`, { x: x.x, z: x.z, ...(Number.isNaN(x.yaw) ? {} : { yaw: rad(Number(x.yaw)) }) })
                    },
                  })
                  refresh(r)
                }, 'small'),
                n.source === 'patched' ? button('Restore', async () => refresh(await attempt(() => post<Result>(`npcs/${encodeURIComponent(n.code)}/restore`))), 'small') : null,
                button('Remove…', async () => {
                  if (await confirmDialog({ title: 'Remove NPC', message: `Remove ${n.name} (${n.code})?${n.source === 'authored' ? '' : ' The exported NPC is hidden by the override (Restore brings it back).'} Quests that use it cannot be taken or turned in meanwhile.`, confirm: 'Remove', danger: true })) {
                    refresh(await attempt(() => post<Result>(`npcs/${encodeURIComponent(n.code)}/remove`)))
                  }
                }, 'small'),
              ],
      },
    ],
  })
  const add = button('Add NPC…', async () => {
    let r: Result | undefined
    await formDialog({
      title: 'Add an NPC',
      intro: 'A new NPC wears the look of an exported NPC (its base).',
      fields: [
        { name: 'base', label: 'Base NPC code', required: true, placeholder: 'NPC_CH_POTION', suggest: async (q) => (q.length < 2 ? [] : (await get<AdminPage<AdminNpcRow>>(`npcs${qs({ q, size: 20 })}`)).rows.filter((x) => x.source !== 'authored').map((x) => ({ value: x.code, label: x.name }))) },
        { name: 'name', label: 'Name', required: true, maxlength: 32 },
        { name: 'x', label: 'X (m)', type: 'number', required: true, step: 'any' },
        { name: 'z', label: 'Z (m)', type: 'number', required: true, step: 'any' },
        { name: 'yaw', label: 'Facing (degrees)', type: 'number', value: 0, step: 'any' },
      ],
      submit: 'Add',
      onSubmit: async (x) => {
        r = await post<Result>('npcs', { base: String(x.base).trim(), name: x.name, x: x.x, z: x.z, yaw: rad(Number.isNaN(x.yaw) ? 0 : Number(x.yaw)) })
      },
    })
    refresh(r)
  }, 'primary')
  const undo = button('Undo last change', async () => {
    if (await confirmDialog({ title: 'Undo', message: 'Put the NPC overrides back to their previous version?', confirm: 'Undo' })) refresh(await attempt(() => post<Result>('npcs/undo')))
  })
  root.append(card(null, h('div', { class: 'actions card-actions' }, add, undo), table.root))
}
