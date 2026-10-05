import type { AdminLoginResponse } from '@sro/shared'
import { health, post, servers, session } from '../api.ts'
import { badge, clear, errorText, h } from '../ui.ts'

/**
 * The panel's login for the active server profile: an existing account of that server whose role is admin (granted on
 * that server with `pnpm gm grant <name> --role admin`). The server picker switches profiles; Servers manages them.
 */
export function loginPage(root: HTMLElement, done: () => void): void {
  const user = h('input', { class: 'input', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 16, required: true })
  const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', maxlength: 64, required: true })
  const error = h('div', { class: 'form-error', role: 'alert' })
  const submit = h('button', { class: 'btn btn-primary btn-wide btn-lg', type: 'submit' }, 'Sign in')
  const picker = h('select', { class: 'input', id: 'login-server' }, servers.list().map((p) => h('option', { value: p.id, selected: p.id === servers.activeId }, `${p.name} (${servers.display(p)})`)))
  const checking = () => [h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking the server…']
  const status = h('div', { class: 'login-status', 'aria-live': 'polite' }, checking())
  const check = async () => {
    const p = servers.active()
    clear(status, checking())
    const r = await health(p)
    if (servers.activeId !== p.id) return
    clear(
      status,
      r.ok
        ? [badge(r.info.environment === 'live' ? 'LIVE' : 'LOCAL', r.info.environment === 'live' ? 'bad' : 'ok'), h('span', null, `${r.info.name}, world ${r.info.world}`)]
        : [badge('unreachable', 'bad'), h('span', null, r.reason)],
    )
  }
  picker.addEventListener('change', () => {
    servers.activeId = picker.value
    error.textContent = ''
    void check()
  })
  const form = h(
    'form',
    { class: 'login-card', novalidate: true },
    h('div', { class: 'login-brand' }, h('span', { class: 'brand-mark big', 'aria-hidden': 'true' }, '絲'), h('h1', null, 'Silkroad'), h('p', null, 'Admin panel')),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', for: 'login-server' }, 'Server'),
      picker,
      h('div', { class: 'login-server-row' }, status, h('a', { class: 'link small', href: '#/servers' }, 'Manage servers')),
    ),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Account'), user),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password'), pass),
    error,
    submit,
    h('p', { class: 'login-hint' }, 'Admin accounts of that server only. Make one with ', h('code', null, 'pnpm deploy:gm grant <name> --role admin'), '.'),
  )
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    error.textContent = ''
    if (!user.value.trim() || !pass.value) {
      error.textContent = 'Enter your account and password.'
      ;(user.value.trim() ? pass : user).focus()
      return
    }
    submit.disabled = true
    try {
      const r = await post<AdminLoginResponse>('login', { username: user.value.trim(), password: pass.value })
      session.set(r)
      pass.value = ''
      done()
    } catch (err) {
      error.textContent = errorText(err)
      pass.select()
    } finally {
      submit.disabled = false
    }
  })
  root.replaceChildren(h('div', { class: 'login' }, form))
  void check()
  user.focus()
}
