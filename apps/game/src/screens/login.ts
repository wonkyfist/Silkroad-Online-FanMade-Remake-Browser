/**
 * Login / register. Layout from Media/resinfo/pstitle.txt (section Login, window login_window 288x140):
 * GDR_EDIT_ID (110,32,135,20), GDR_EDIT_PASS (110,60,135,20), third row (110,88,86,20; widened to 135 here),
 * labels at x=36, message strip login_deco_gradation below the window. The wordmark stands in for outer/logo.
 * Rebuilt on the UI kit (docs/UI.md §4.7): the mode caption inside the window, kit checkbox, outer buttons that fit.
 */
import { ACCOUNT_NAME, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type ApiLoginResponse } from '@sro/shared'
import type { App, Screen, ScreenParams } from '../app.ts'
import { t } from '../i18n/index.ts'
import { GameError, registrationOpen } from '../net/api.ts'
import { prefetchStage } from '../stage/prefetch.ts'
import { anchor, bars } from '../ui/chrome.ts'
import { el, input, Listeners, place } from '../ui/dom.ts'
import { Checkbox } from '../ui/kit/index.ts'
import { wordmark } from '../ui/wordmark.ts'
import { outerBox, outerButton, setDisabled } from './outer-ui.ts'
import { titleScene } from './title.ts'

const USER_KEY = 'sro.username'

function readRemembered(): string {
  try {
    return localStorage.getItem(USER_KEY) ?? ''
  } catch {
    return ''
  }
}

function remember(name: string | null): void {
  try {
    if (name) localStorage.setItem(USER_KEY, name)
    else localStorage.removeItem(USER_KEY)
  } catch {
    // ignore
  }
}

export function describeError(err: unknown): string {
  if (err instanceof GameError) {
    switch (err.code) {
      case 'unauthorized':
        return err.message || t('error.unauthorized')
      case 'name_taken':
        return err.message || t('error.nameTaken')
      case 'rate_limited':
        return t('error.rateLimited')
      case 'version_mismatch':
        return t('error.versionMismatch', { detail: err.message })
      case 'forbidden':
        return err.message || t('error.forbidden')
      default:
        return err.message || t('error.generic', { code: err.code })
    }
  }
  return err instanceof Error ? err.message : String(err)
}

export function loginScreen(app: App, params: ScreenParams['login']): Screen {
  titleScene(app)
  prefetchStage()
  app.music.play(app.art.musicUrl('maintheme_cut'))
  app.setSession(null)

  const art = app.art
  const root = el('div', 'screen login')
  const logo = anchor(wordmark('small'), 0.5, 0.3)

  // The window art has two 135-px boxes and a narrower third (the retail server row); the third row gets a full
  // 135-px box of the same look, so ID, Password and Confirm line up (docs/UI.md A14).
  const win = art.window('outer/login_window', 'login-window', 288, 140)
  const caption = place(el('div', 'login-caption kit-t-caption'), [16, 11, 256, 15])
  const user = place(input('field', 'text', { maxlength: '16', 'aria-label': t('login.id') }), [110, 32, 135, 20])
  const pass = place(input('field', 'password', { maxlength: '32', 'aria-label': t('login.password') }), [110, 60, 135, 20])
  const box3 = outerBox([110, 88, 135, 20])
  const confirm = place(input('field', 'password', { maxlength: '32', 'aria-label': t('login.confirmAria') }), [110, 88, 135, 20])
  const rememberBox = new Checkbox(art, { label: t('login.remember'), className: 'login-remember' })
  place(rememberBox.root, [112, 88, 131, 20])
  const label3 = place(el('div', 'label kit-t-label'), [36, 91, 70, 15])
  win.append(
    caption,
    place(el('div', 'label kit-t-label', t('login.id')), [36, 35, 70, 15]),
    user,
    place(el('div', 'label kit-t-label', t('login.password')), [36, 63, 70, 15]),
    pass,
    label3,
    box3,
    confirm,
    rememberBox.root,
  )

  // Progress and errors: the retail message strip under the window (GDR_STA_CHANNELMESSAGE), shown only with a message.
  const message = art.image('outer/login_deco_gradation', 'login-message', 320, 24)
  const msgText = el('span')
  message.append(msgText)
  message.hidden = true
  win.append(place(message, [-16, 146, 320, 24]))

  const primary = outerButton(art, t('login.connect'), { primary: true })
  const secondary = outerButton(art, t('login.register'))
  const buttons = place(el('div', 'button-row'), [0, 180, 288, 40])
  buttons.append(primary, secondary)
  win.append(buttons)
  // A stale client after a deploy (docs/UX_GAPS.md L6): one click reloads the page for the new version.
  const reload = outerButton(art, t('login.reload'), {}, () => location.reload())
  place(reload, [98, 228, 0, 0])
  reload.hidden = true
  win.append(reload)

  root.append(...bars(art, 'outer/blackbar_up_18', 'outer/blackbar_down_notext'), logo, anchor(win, 0.5, 0.56))
  if (app.transport.mock) root.append(el('div', 'mock-badge', t('login.mockBadge')))
  app.ui.append(root)

  let mode: 'login' | 'register' = 'login'
  let busy = false
  const setMessage = (text: string, kind: 'info' | 'error' = 'info', stale = false) => {
    msgText.textContent = text
    message.title = text
    message.hidden = !text
    message.classList.toggle('error', kind === 'error')
    reload.hidden = !stale
  }
  const setMode = (m: typeof mode) => {
    mode = m
    const reg = m === 'register'
    confirm.hidden = !reg
    rememberBox.root.hidden = reg
    label3.textContent = reg ? t('login.confirm') : ''
    // Retail shows no caption on the login form; the register form names itself (docs/UI.md §4.7).
    caption.textContent = reg ? t('login.registerHint') : ''
    primary.setLabel(reg ? t('login.create') : t('login.connect'))
    secondary.setLabel(reg ? t('login.back') : t('login.register'))
    setMessage('')
    ;(user.value ? pass : user).focus()
  }

  const saved = readRemembered()
  user.value = saved
  rememberBox.checked = true
  setMode('login')

  // The admin panel's registration switch (docs/ADMIN.md): asked each time this screen opens, so turning it back on
  // brings Register back without a rebuild. The server refuses registration on its own while it is closed.
  let disposed = false
  const closeRegistration = () => {
    secondary.hidden = true
    if (mode === 'register') setMode('login')
  }
  void app.transport.api
    .servers()
    .then(list => {
      if (!disposed && !registrationOpen(list)) closeRegistration()
    })
    .catch(() => {})
  if (params?.error) setMessage(params.error, 'error', params.error === t('net.versionMismatch'))

  const setBusy = (b: boolean) => {
    busy = b
    for (const e of [user, pass, confirm]) e.disabled = b
    rememberBox.setDisabled(b)
    setDisabled([primary, secondary], b)
  }

  const enter = async (username: string, res: ApiLoginResponse) => {
    app.token = res.token
    app.tokenExpiresAt = res.expiresAt
    app.username = username
    remember(rememberBox.checked ? username : null)
    await app.go('servers')
  }
  const doLogin = async (username: string, password: string) => enter(username, await app.transport.api.login({ username, password }))

  const submit = async () => {
    if (busy) return
    const username = user.value.trim()
    const password = pass.value
    if (!username || !password) {
      setMessage(t('login.missing'), 'error')
      ;(username ? pass : user).focus()
      return
    }
    if (mode === 'register' && !ACCOUNT_NAME.test(username)) {
      setMessage(t('login.badId'), 'error')
      user.focus()
      return
    }
    if (mode === 'register' && (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH)) {
      setMessage(t('login.badPassword', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }), 'error')
      pass.focus()
      return
    }
    if (mode === 'register' && password !== confirm.value) {
      setMessage(t('login.mismatch'), 'error')
      confirm.focus()
      return
    }
    setBusy(true)
    setMessage(mode === 'register' ? t('login.creating') : t('login.connecting'))
    try {
      if (mode === 'register') await enter(username, await app.transport.api.register({ username, password }))
      else await doLogin(username, password)
    } catch (err) {
      // Registration was closed meanwhile: back to the login form, with the server's message.
      if (mode === 'register' && err instanceof GameError && err.code === 'forbidden') closeRegistration()
      setMessage(describeError(err), 'error', err instanceof GameError && err.code === 'version_mismatch')
      setBusy(false)
      pass.select()
    }
  }

  const ls = new Listeners()
  ls.on(primary, 'click', () => void submit())
  ls.on(secondary, 'click', () => setMode(mode === 'login' ? 'register' : 'login'))
  ls.on(win, 'keydown', ev => {
    if (ev.key === 'Enter') void submit()
    if (ev.key === 'Escape' && mode === 'register') setMode('login')
  })

  if (app.params.auto) {
    // Mock-only shortcut for visual checks: tester/tester straight to the server list.
    setBusy(true)
    void app.transport.api
      .login({ username: 'tester', password: 'tester' })
      .catch(() => app.transport.api.register({ username: 'tester', password: 'tester' }))
      .then(res => enter('tester', res))
      .catch(err => {
        setBusy(false)
        setMessage(describeError(err), 'error')
      })
  }

  return {
    dispose() {
      disposed = true
      ls.clear()
    },
  }
}
