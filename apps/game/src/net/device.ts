/**
 * docs/ANTI_ALT.md §5: the signals register and login send so the server can limit accounts per device.
 *
 * - The device ID: random, made once, kept in localStorage, IndexedDB and a first-party cookie; whichever survives
 *   restores the others. The server stores only a salted hash of it.
 * - A light fingerprint: SHA-256 of the user agent, screen, time zone, languages, WebGL renderer and core count. Many
 *   machines share one, so the server treats it as a soft signal only. Nothing here leaves the browser except the two
 *   values; every step fails quietly (private windows, blocked storage, no WebGL).
 */

const KEY = 'jangan.device'
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/
const DB = 'jangan-device'

function fromLocal(): string | null {
  try {
    const v = localStorage.getItem(KEY)
    return v && DEVICE_RE.test(v) ? v : null
  } catch {
    return null
  }
}

function fromCookie(): string | null {
  try {
    const m = /(?:^|;\s*)jdid=([A-Za-z0-9_-]{16,64})/.exec(document.cookie)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1)
      open.onupgradeneeded = () => open.result.createObjectStore('kv')
      open.onerror = () => resolve(null)
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction('kv', mode)
          const req = run(tx.objectStore('kv'))
          tx.oncomplete = () => {
            open.result.close()
            resolve(req ? (req.result ?? null) : null)
          }
          tx.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }
    } catch {
      resolve(null)
    }
  })
}

function newId(): string {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function store(id: string): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* blocked storage */
  }
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `jdid=${id}; Max-Age=${60 * 60 * 24 * 400}; Path=/; SameSite=Lax${secure}`
  } catch {
    /* no cookies */
  }
  void idb('readwrite', (s) => {
    s.put(id, KEY)
  })
}

let device: Promise<string> | null = null

export function deviceId(): Promise<string> {
  device ??= (async () => {
    const fromDb = await Promise.race([idb<string>('readonly', (s) => s.get(KEY)), new Promise<null>((r) => setTimeout(() => r(null), 500))])
    const id = fromLocal() ?? (fromDb && DEVICE_RE.test(fromDb) ? fromDb : null) ?? fromCookie() ?? newId()
    store(id)
    return id
  })()
  return device
}

function webglRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return String(r ?? '')
  } catch {
    return ''
  }
}

let fp: Promise<string | null> | null = null

export function fingerprint(): Promise<string | null> {
  fp ??= (async () => {
    try {
      const parts = [
        navigator.userAgent,
        `${screen.width}x${screen.height}x${screen.colorDepth}@${window.devicePixelRatio}`,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        (navigator.languages ?? [navigator.language]).join(','),
        webglRenderer(),
        String(navigator.hardwareConcurrency ?? ''),
      ]
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')))
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch {
      return null // no subtle crypto outside a secure context
    }
  })()
  return fp
}

/** The fields register and login add to their body. */
export async function deviceSignals(): Promise<{ device?: string; fp?: string }> {
  const [d, f] = await Promise.all([deviceId().catch(() => null), fingerprint()])
  return { ...(d ? { device: d } : {}), ...(f ? { fp: f } : {}) }
}
