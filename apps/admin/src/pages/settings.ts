import type { AdminSettingState, AdminSettingValue, AdminSettingsView } from '@sro/shared'
import { get, post, put } from '../api.ts'
import { attempt, badge, button, card, clear, confirmDialog, errorText, h, pageHeader, toast } from '../ui.ts'

/**
 * Runtime settings (docs/ADMIN.md §5, §6): saved in the database, applied live where the server allows, otherwise
 * marked "after restart". Each row shows the base value (environment or default) and can be reset to it.
 */
export function settingsPage(root: HTMLElement): void {
  const body = h('div')
  root.append(body)
  const load = async () => {
    try {
      render(await get<AdminSettingsView>('settings'))
    } catch (e) {
      clear(body, pageHeader('Settings'), h('p', { class: 'error' }, errorText(e)))
    }
  }
  const render = (view: AdminSettingsView) => {
    const inputs = new Map<string, { s: AdminSettingState; read: () => AdminSettingValue | null }>()
    const groups = new Map<string, AdminSettingState[]>()
    for (const s of view.settings) groups.set(s.group, [...(groups.get(s.group) ?? []), s])
    const saveAll = async () => {
      const values: Record<string, AdminSettingValue> = {}
      for (const [key, { s, read }] of inputs) {
        const v = read()
        if (v === null) return toast(`${s.label}: enter a value.`, 'error')
        if (v !== (s.stored ?? (s.apply === 'live' ? s.running : s.base))) values[key] = v
      }
      if (Object.keys(values).length === 0) return toast('Nothing changed.', 'info')
      const restart = view.settings.filter((s) => s.key in values && s.apply === 'restart').map((s) => s.label)
      if (restart.length && !(await confirmDialog({ title: 'Save settings', message: `These apply after a restart:\n${restart.join('\n')}`, confirm: 'Save' }))) return
      const r = await attempt(() => put<AdminSettingsView>('settings', { values }), `Saved ${Object.keys(values).length} setting(s).`)
      if (r) render(r)
    }
    // One Save at the top (the page header) and one under the last group.
    const save = button('Save changes', () => void saveAll(), 'primary')
    const saveBottom = button('Save changes', () => void saveAll(), 'primary')
    const restartBtn = view.restart
      ? button('Restart server…', async () => {
          if (!(await confirmDialog({ title: 'Restart the server', message: 'Everyone is saved and disconnected; the server is back in about 10 seconds.', confirm: 'Restart now', danger: true }))) return
          await attempt(() => post('restart'), 'Restarting…')
        }, 'danger')
      : null
    const pending = view.settings.filter((s) => s.pending)
    clear(
      body,
      pageHeader('Settings', 'Panel values override the environment (silkroad.local.env) and survive restarts and deploys.', ...[restartBtn, save].filter((x): x is HTMLButtonElement => !!x)),
      pending.length
        ? h('div', { class: 'notice warn' }, `Waiting for a restart: ${pending.map((s) => s.label).join(', ')}.`, view.restart ? '' : ' Restart the service by hand (systemctl --user restart silkroad).')
        : null,
      [...groups].map(([group, list]) =>
        card(
          group,
          h(
            'div',
            { class: 'settings' },
            list.map((s) => {
              const { el, read } = control(s)
              inputs.set(s.key, { s, read })
              const reset = s.stored !== null
                ? button('Reset', async () => {
                    const r = await attempt(() => put<AdminSettingsView>('settings', { values: { [s.key]: null } }), `${s.label} is back to ${fmt(s.base)}.`)
                    if (r) render(r)
                  }, 'small')
                : null
              return h(
                'div',
                { class: 'setting' },
                h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, s.label), s.apply === 'live' ? badge('live', 'ok') : badge('after restart', 'info'), s.pending ? badge('pending', 'gold') : null, s.stored !== null ? badge('panel', 'gold') : null),
                h('div', { class: 'setting-control' }, el, reset),
                h('div', { class: 'setting-meta dim small' }, `${s.env} · base ${fmt(s.base)}${s.apply === 'restart' ? ` · running ${fmt(s.running)}` : ''}${s.min !== undefined ? ` · ${s.min}–${s.max}` : ''}`),
                s.note ? h('div', { class: 'setting-note dim small' }, s.note) : null,
              )
            }),
          ),
        ),
      ),
      h('div', { class: 'actions end' }, saveBottom),
    )
  }
  void load()
}

function fmt(v: AdminSettingValue): string {
  return typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v)
}

function control(s: AdminSettingState): { el: HTMLElement; read: () => AdminSettingValue | null } {
  const current = s.stored ?? (s.apply === 'live' ? s.running : s.base)
  if (s.type === 'bool') {
    const box = h('input', { type: 'checkbox', checked: current === true, 'aria-label': s.label })
    const text = h('span', { class: 'switch-text' }, current ? 'On' : 'Off')
    box.addEventListener('change', () => (text.textContent = box.checked ? 'On' : 'Off'))
    return { el: h('label', { class: 'switch' }, box, h('span', { class: 'switch-track' }), text), read: () => box.checked }
  }
  if (s.type === 'enum') {
    const sel = h('select', { class: 'input', 'aria-label': s.label }, (s.options ?? []).map((o) => h('option', { value: o, selected: o === current }, o)))
    return { el: sel, read: () => sel.value }
  }
  if (s.type === 'text') {
    // docs/WINTER.md §6: the season's days (MM-DD) and its time zone; the server checks the value again
    const inp = h('input', { class: 'input', type: 'text', value: String(current), maxlength: 64, spellcheck: 'false', autocomplete: 'off', 'aria-label': s.label, ...(s.pattern ? { pattern: s.pattern } : {}), ...(s.placeholder ? { placeholder: s.placeholder } : {}) })
    return {
      el: inp,
      read: () => {
        const v = inp.value.trim()
        if (v === '') return null
        if (s.pattern && !new RegExp(s.pattern).test(v)) return null
        return v
      },
    }
  }
  const inp = h('input', { class: 'input num-input', type: 'number', value: String(current), min: s.min, max: s.max, step: s.type === 'int' ? 1 : 'any', 'aria-label': s.label })
  return {
    el: inp,
    read: () => {
      if (inp.value.trim() === '') return null
      const v = Number(inp.value)
      return Number.isFinite(v) ? v : null
    },
  }
}
