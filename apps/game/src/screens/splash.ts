/**
 * Logo splash: the wordmark fades in and out over black; any click or key skips it.
 * The wordmark takes the place and size of outer/logo-big (720x200), which carries the Vietnamese logo.
 */
import type { App, Screen } from '../app.ts'
import { t } from '../i18n/index.ts'
import { anchor } from '../ui/chrome.ts'
import { el, Listeners } from '../ui/dom.ts'
import { wordmark } from '../ui/wordmark.ts'

export function splashScreen(app: App): Screen {
  app.releaseScene()
  app.music.play(app.art.musicUrl('maintheme_cut'))
  const root = el('div', 'screen splash')
  const logo = anchor(wordmark('big'), 0.5, 0.5)
  logo.classList.add('splash-logo')
  root.append(logo, el('div', 'splash-hint', t('splash.hint')))
  app.ui.append(root)

  const ls = new Listeners()
  let done = false
  const next = () => {
    if (done) return
    done = true
    void app.go('login')
  }
  requestAnimationFrame(() => logo.classList.add('in'))
  const tOut = setTimeout(() => logo.classList.replace('in', 'out'), 3200)
  const tNext = setTimeout(next, 4400)
  ls.on(root, 'pointerdown', next)
  ls.on(window, 'keydown', next)
  return {
    dispose() {
      clearTimeout(tOut)
      clearTimeout(tNext)
      ls.clear()
    },
  }
}
