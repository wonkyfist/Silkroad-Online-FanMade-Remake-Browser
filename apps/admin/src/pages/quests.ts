import type { AdminPage, AdminQuestDetail, AdminQuestRow, ApiGmQuestResult } from '@sro/shared'
import { AdminApiError, del, get, post, put, qs } from '../api.ts'
import { attempt, badge, button, card, confirmDialog, dataTable, errorText, h, pageHeader, toast, type TableHandle } from '../ui.ts'

/**
 * Quests (docs/QUESTS.md §5.4): the GM quest editor's own routes with the admin as the editor. A change is an override
 * file in DATA_DIR/content/quests; Revert deletes it (back to the repo version). The JSON editor is for small fixes;
 * the in-game GM quest form is the comfortable editor.
 */
export function questsPage(root: HTMLElement): void {
  let table: TableHandle
  const editor = h('div')
  table = dataTable<AdminQuestRow>({
    placeholder: 'Search quests',
    load: (q, page, size) => get<AdminPage<AdminQuestRow>>(`quests${qs({ q, page, size })}`),
    onRow: (r) => void open(r.id),
    columns: [
      { label: 'Quest', render: (r) => [h('strong', null, r.title), h('span', { class: 'mono dim small' }, ` ${r.id}`)] },
      { label: 'Source', render: (r) => badge(r.source === 'override' ? 'override' : 'repo', r.source === 'override' ? 'gold' : 'dim') },
      { label: 'Rev', render: (r) => String(r.rev), class: 'num' },
      { label: 'State', render: (r) => [r.disabled ? badge('disabled', 'bad') : badge('enabled', 'ok'), r.issues.some((i) => i.severity === 'error') ? badge('issues', 'bad') : null] },
      {
        label: '',
        class: 'row-actions',
        render: (r) => [
          button(r.disabled ? 'Enable' : 'Disable', async () => {
            if (await attempt(() => post<ApiGmQuestResult>(`quests/${r.id}/${r.disabled ? 'enable' : 'disable'}`), `${r.id} ${r.disabled ? 'enabled' : 'disabled'}.`)) void table.reload()
          }, 'small'),
          r.source === 'override'
            ? button('Revert…', async () => {
                if (!(await confirmDialog({ title: 'Revert quest', message: `Delete the override of ${r.id} (back to the repo version, or gone if it only exists as an override)?`, confirm: 'Revert', danger: true }))) return
                if (await attempt(() => del(`quests/${r.id}`), 'Reverted.')) void table.reload()
              }, 'small')
            : null,
        ],
      },
    ],
  })
  const open = async (id: string) => {
    try {
      const d = await get<AdminQuestDetail>(`quests/${encodeURIComponent(id)}`)
      const text = h('textarea', { class: 'input mono', rows: 22, spellcheck: 'false', value: JSON.stringify(d.quest, null, 2) })
      const issues = h('div', { class: 'issues' }, d.issues.map((i) => h('div', { class: i.severity === 'error' ? 'error' : 'warn' }, `${i.path}: ${i.message}`)))
      const save = button('Save override', async () => {
        let quest: unknown
        try {
          quest = JSON.parse(text.value)
        } catch (e) {
          return toast(`Not JSON: ${(e as Error).message}`, 'error')
        }
        try {
          const r = await put<ApiGmQuestResult>(`quests/${encodeURIComponent(id)}`, { quest, baseRev: d.rev })
          toast(`Saved ${id} (rev ${r.rev}).`)
          issues.replaceChildren(...r.issues.map((i) => h('div', { class: i.severity === 'error' ? 'error' : 'warn' }, `${i.path}: ${i.message}`)))
          void table.reload()
        } catch (e) {
          if (e instanceof AdminApiError && e.issues.length) issues.replaceChildren(...e.issues.map((i) => h('div', { class: 'error' }, `${i.path}: ${i.message}`)))
          toast(errorText(e), 'error')
        }
      }, 'primary')
      editor.replaceChildren(card(`${d.title} (${d.id}, rev ${d.rev}, from ${d.file})`, h('p', { class: 'dim small' }, 'The quest object as JSON. Items and locations it adds are kept by the in-game editor; this view edits the quest only.'), text, issues, h('div', { class: 'actions' }, save, button('Close', () => editor.replaceChildren()))))
      editor.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }
  root.append(pageHeader('Quests', 'Disable a broken quest, revert an override, or fix a field.'), card(null, table.root), editor)
}
