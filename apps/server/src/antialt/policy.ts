import { WINDOW_UNITS, type WindowUnit } from './window.ts'

/**
 * docs/ANTI_ALT.md §2: the "Registration & anti-alt" settings, kept as one JSON row (antialt_meta.policy) and edited on
 * the admin panel's page of that name. Every limit is on/off, a count and a window (minutes, hours, days or weeks).
 */

export interface Limit {
  on: boolean
  count: number
  amount: number
  unit: WindowUnit
}

/**
 * What a detection (hosting range, Tor exit, external lookup) does. The block modes escalate: 'block_character' also
 * refuses registration, 'block_login' also refuses registration and character creation. 'flag' only writes the log.
 */
export const DETECT_MODES = ['off', 'flag', 'block_register', 'block_character', 'block_login'] as const
export type DetectMode = (typeof DETECT_MODES)[number]

export interface AntiAltPolicy {
  /** Requests from this machine (127.0.0.0/8, ::1) skip every limit: bots, benches and tests on the host. */
  exemptLoopback: boolean
  account: {
    perIp: Limit
    perSubnet: Limit
    perDevice: Limit
    /** Accounts ever made on one device (no window). */
    deviceLifetime: { on: boolean; count: number }
  }
  character: {
    perAccount: Limit
    perDevice: Limit
    perIp: Limit
    /** Deleted characters still count, so delete-and-recreate does not dodge the limit. */
    countDeleted: boolean
  }
  /**
   * The fingerprint is a soft signal: alone it never blocks. On: an account made with the same fingerprint from the
   * same subnet counts as the same device (catches a cleared device ID on one network). It always shows in Linked accounts.
   */
  fingerprintWithSubnet: boolean
  detect: { hosting: DetectMode; tor: DetectMode; external: DetectMode }
  /** Cloudflare Turnstile on register; needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in the environment. */
  captcha: boolean
  /** Days the blocked/flagged log and the login records are kept. */
  logDays: number
}

const lim = (on: boolean, count: number, amount: number, unit: WindowUnit): Limit => ({ on, count, amount, unit })

/** The defaults; `registerPerHour` is the old "Registrations per IP per hour" (REGISTER_LIMIT or its saved value). */
export function defaultPolicy(registerPerHour = 10): AntiAltPolicy {
  return {
    exemptLoopback: true,
    account: {
      perIp: lim(true, registerPerHour, 1, 'hours'),
      perSubnet: lim(true, 20, 1, 'days'),
      perDevice: lim(true, 3, 1, 'days'),
      deviceLifetime: { on: true, count: 10 },
    },
    character: {
      perAccount: lim(true, 4, 1, 'days'),
      perDevice: lim(true, 8, 1, 'days'),
      perIp: lim(true, 12, 1, 'days'),
      countDeleted: true,
    },
    fingerprintWithSubnet: true,
    detect: { hosting: 'flag', tor: 'flag', external: 'flag' },
    captcha: false,
    logDays: 30,
  }
}

const COUNT_MAX = 100_000
const AMOUNT_MAX = 1000

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Checks a whole policy from the panel (or the saved row): every field present, in bounds, no extra field. Returns the
 * policy or the first problem.
 */
export function checkPolicy(v: unknown): { policy: AntiAltPolicy } | { problem: string } {
  const problems: string[] = []
  const at = (path: string, msg: string) => problems.push(`${path}: ${msg}`)
  const keys = (o: Record<string, unknown>, path: string, want: string[]) => {
    for (const k of Object.keys(o)) if (!want.includes(k)) at(path, `unknown field ${k}`)
  }
  const bool = (o: Record<string, unknown>, k: string, path: string): boolean => {
    if (typeof o[k] !== 'boolean') at(`${path}.${k}`, 'must be true or false')
    return o[k] === true
  }
  const int = (o: Record<string, unknown>, k: string, path: string, min: number, max: number): number => {
    const n = o[k]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) at(`${path}.${k}`, `must be a whole number ${min}-${max}`)
    return typeof n === 'number' ? n : min
  }
  const obj = (o: Record<string, unknown>, k: string, path: string): Record<string, unknown> => {
    if (!isObj(o[k])) {
      at(`${path}.${k}`, 'missing')
      return {}
    }
    return o[k] as Record<string, unknown>
  }
  const limit = (o: Record<string, unknown>, k: string, path: string): Limit => {
    const l = obj(o, k, path)
    const p = `${path}.${k}`
    keys(l, p, ['on', 'count', 'amount', 'unit'])
    if (!(WINDOW_UNITS as readonly unknown[]).includes(l.unit)) at(`${p}.unit`, `must be one of ${WINDOW_UNITS.join(', ')}`)
    return { on: bool(l, 'on', p), count: int(l, 'count', p, 0, COUNT_MAX), amount: int(l, 'amount', p, 1, AMOUNT_MAX), unit: l.unit as WindowUnit }
  }
  const mode = (o: Record<string, unknown>, k: string, path: string): DetectMode => {
    if (!(DETECT_MODES as readonly unknown[]).includes(o[k])) at(`${path}.${k}`, `must be one of ${DETECT_MODES.join(', ')}`)
    return o[k] as DetectMode
  }
  if (!isObj(v)) return { problem: 'the policy must be an object' }
  keys(v, 'policy', ['exemptLoopback', 'account', 'character', 'fingerprintWithSubnet', 'detect', 'captcha', 'logDays'])
  const a = obj(v, 'account', 'policy')
  keys(a, 'account', ['perIp', 'perSubnet', 'perDevice', 'deviceLifetime'])
  const life = obj(a, 'deviceLifetime', 'account')
  keys(life, 'account.deviceLifetime', ['on', 'count'])
  const c = obj(v, 'character', 'policy')
  keys(c, 'character', ['perAccount', 'perDevice', 'perIp', 'countDeleted'])
  const d = obj(v, 'detect', 'policy')
  keys(d, 'detect', ['hosting', 'tor', 'external'])
  const policy: AntiAltPolicy = {
    exemptLoopback: bool(v, 'exemptLoopback', 'policy'),
    account: {
      perIp: limit(a, 'perIp', 'account'),
      perSubnet: limit(a, 'perSubnet', 'account'),
      perDevice: limit(a, 'perDevice', 'account'),
      deviceLifetime: { on: bool(life, 'on', 'account.deviceLifetime'), count: int(life, 'count', 'account.deviceLifetime', 0, COUNT_MAX) },
    },
    character: {
      perAccount: limit(c, 'perAccount', 'character'),
      perDevice: limit(c, 'perDevice', 'character'),
      perIp: limit(c, 'perIp', 'character'),
      countDeleted: bool(c, 'countDeleted', 'character'),
    },
    fingerprintWithSubnet: bool(v, 'fingerprintWithSubnet', 'policy'),
    detect: { hosting: mode(d, 'hosting', 'detect'), tor: mode(d, 'tor', 'detect'), external: mode(d, 'external', 'detect') },
    captcha: bool(v, 'captcha', 'policy'),
    logDays: int(v, 'logDays', 'policy', 1, 3650),
  }
  return problems.length ? { problem: problems[0] } : { policy }
}

/** How strongly a mode acts: a detection blocks an action when its mode reaches the action's rank. */
export const MODE_RANK: Record<DetectMode, number> = { off: 0, flag: 1, block_register: 2, block_character: 3, block_login: 4 }
export const ACTION_RANK = { register: 2, character: 3, login: 4 } as const
export type GuardAction = keyof typeof ACTION_RANK
