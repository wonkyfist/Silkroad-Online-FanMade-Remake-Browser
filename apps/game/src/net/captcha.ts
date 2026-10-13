/**
 * docs/ANTI_ALT.md §6: Cloudflare Turnstile on the register form, only when the server names a site key
 * (ServerInfo.captchaSiteKey: the owner set TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY and turned the check on).
 */

interface Turnstile {
  render(el: HTMLElement, o: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void; theme?: string }): string
  reset(id: string): void
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<Turnstile> | null = null

function load(): Promise<Turnstile> {
  loading ??= new Promise((resolve, reject) => {
    const w = window as unknown as { turnstile?: Turnstile }
    if (w.turnstile) return resolve(w.turnstile)
    const s = document.createElement('script')
    s.src = SCRIPT
    s.async = true
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile missing')))
    s.onerror = () => {
      loading = null
      reject(new Error('turnstile failed to load'))
    }
    document.head.append(s)
  })
  return loading
}

export interface CaptchaWidget {
  /** The current token, or null until the player passes the check. */
  token(): string | null
  /** A token is good once: a fresh check after every register attempt. */
  reset(): void
}

export function mountCaptcha(host: HTMLElement, siteKey: string): CaptchaWidget {
  let token: string | null = null
  let id: string | null = null
  let api: Turnstile | null = null
  load()
    .then((t) => {
      api = t
      id = t.render(host, { sitekey: siteKey, theme: 'dark', callback: (v) => (token = v), 'expired-callback': () => (token = null) })
    })
    .catch(() => {
      host.textContent = 'The robot check could not load. Check your connection or ad blocker.'
    })
  return {
    token: () => token,
    reset: () => {
      token = null
      if (api && id !== null) api.reset(id)
    },
  }
}
