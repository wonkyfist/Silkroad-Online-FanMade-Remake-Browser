import { get, post } from '../api.ts'
import { svgIcon } from '../icons.ts'
import { attempt, badge, button, card, clear, confirmDialog, emptyState, errorText, fmtAgo, fmtTime, formDialog, h, pageHeader, stackTable } from '../ui.ts'

/**
 * Registration & anti-alt (docs/ANTI_ALT.md §8): the limits (each on/off, a count and a window), VPN / proxy / hosting
 * detection, the robot check, the log of blocked and flagged attempts (with Lift), the allowlist, and (accounts.ts)
 * the accounts linked to one account. Everything goes to `/api/admin/antialt/*` (antialt/admin.ts on the server).
 */

type Unit = 'minutes' | 'hours' | 'days' | 'weeks'
interface Limit {
  on: boolean
  count: number
  amount: number
  unit: Unit
}
type Mode = 'off' | 'flag' | 'block_register' | 'block_character' | 'block_login'
interface Policy {
  exemptLoopback: boolean
  account: { perIp: Limit; perSubnet: Limit; perDevice: Limit; deviceLifetime: { on: boolean; count: number } }
  character: { perAccount: Limit; perDevice: Limit; perIp: Limit; countDeleted: boolean }
  fingerprintWithSubnet: boolean
  detect: { hosting: Mode; tor: Mode; external: Mode }
  captcha: boolean
  logDays: number
}
interface Info {
  policy: Policy
  defaults: Policy
  units: Unit[]
  modes: Mode[]
  env: { captchaConfigured: boolean; lookupProvider: string | null; trustProxy: boolean; trustedProxies: string; clientIpHeader: string }
  lists: { hosting: number; tor: number }
}
interface LogRow {
  id: number
  at: number
  action: string
  outcome: 'blocked' | 'flagged'
  reason: string
  detail: string
  ip: string
  subnet: string
  device: string
  account: string
  lifted: 0 | 1
}
interface AllowRow {
  id: number
  kind: string
  value: string
  note: string
  added_at: number
  added_by: string
}
interface LinkedRow {
  account_id: number
  username: string
  device: 0 | 1
  ip: 0 | 1
  subnet: 0 | 1
  fp: 0 | 1
  last: number
}

const MODE_TEXT: Record<Mode, string> = {
  off: 'Off',
  flag: 'Flag only (log)',
  block_register: 'Block registration',
  block_character: 'Block registration + character creation',
  block_login: 'Block registration, characters and login',
}

const REASON_TEXT: Record<string, string> = {
  'account.perIp': 'accounts per IP',
  'account.perSubnet': 'accounts per subnet',
  'account.perDevice': 'accounts per device',
  'account.deviceLifetime': 'device lifetime cap',
  'character.perAccount': 'characters per account',
  'character.perDevice': 'characters per device',
  'character.perIp': 'characters per IP',
  'detect.hosting': 'hosting / datacenter',
  'detect.tor': 'Tor exit',
  'detect.external': 'VPN lookup',
  captcha: 'robot check failed',
}

function table(heads: string[], rows: HTMLElement[]): HTMLElement {
  return h('div', { class: 'table-scroll' }, stackTable(h('table', { class: 'table' }, h('thead', null, h('tr', null, heads.map((x) => h('th', null, x)))), h('tbody', null, rows))))
}

function checkbox(value: boolean, label: string, set: (v: boolean) => void): HTMLElement {
  const i = h('input', { type: 'checkbox', checked: value, 'aria-label': label })
  i.addEventListener('change', () => set(i.checked))
  return h('label', { class: 'check' }, i, ` ${label}`)
}

function num(value: number, label: string, min: number, max: number, set: (v: number) => void): HTMLInputElement {
  const i = h('input', { class: 'input num-input', type: 'number', value: String(value), min, max, step: 1, 'aria-label': label })
  i.addEventListener('input', () => set(Math.floor(Number(i.value))))
  return i
}

function select<T extends string>(value: T, options: readonly T[], text: (o: T) => string, label: string, set: (v: T) => void): HTMLSelectElement {
  const s = h('select', { class: 'input', 'aria-label': label }, options.map((o) => h('option', { value: o, selected: o === value }, text(o))))
  s.addEventListener('change', () => set(s.value as T))
  return s
}

/** One limit row: [on] count per amount unit. */
function limitRow(label: string, hint: string, l: Limit, units: Unit[]): HTMLElement {
  return h(
    'div',
    { class: 'aa-row' },
    h('div', { class: 'aa-label' }, checkbox(l.on, label, (v) => (l.on = v)), h('div', { class: 'dim small' }, hint)),
    h(
      'div',
      { class: 'aa-inputs' },
      num(l.count, `${label}: count`, 0, 100000, (v) => (l.count = v)),
      h('span', null, ' per '),
      num(l.amount, `${label}: window`, 1, 1000, (v) => (l.amount = v)),
      select(l.unit, units, (u) => u, `${label}: unit`, (v) => (l.unit = v)),
    ),
  )
}

function policyCard(info: Info, saved: (p: Policy) => void): HTMLElement {
  const p: Policy = structuredClone(info.policy)
  const u = info.units
  const modeRow = (label: string, hint: string, k: keyof Policy['detect']) =>
    h('div', { class: 'aa-row' }, h('div', { class: 'aa-label' }, h('strong', null, label), h('div', { class: 'dim small' }, hint)), select(p.detect[k], info.modes, (m) => MODE_TEXT[m], label, (v) => (p.detect[k] = v)))
  const save = button(
    'Save',
    async () => {
      const r = await attempt(() => post<{ policy: Policy }>('antialt/policy', { policy: p }), 'Saved. The new limits apply at once.')
      if (r) saved(r.policy)
    },
    'primary',
  )
  const reset = button('Reset to defaults', async () => {
    if (!(await confirmDialog({ title: 'Reset to defaults', message: 'Put every limit and mode back to its default? (Saved only when you press Save.)', confirm: 'Reset' }))) return
    saved(structuredClone(info.defaults))
  })
  return h(
    'div',
    null,
    card(
      'Account limits',
      h('p', { class: 'dim small' }, 'Counted from successful registrations. A window slides: "3 per 1 days" allows a 4th account 24 hours after the 1st.'),
      limitRow('Accounts per IP', 'One address (was "Registrations per IP per hour").', p.account.perIp, u),
      limitRow('Accounts per subnet', 'IPv4 /24 or IPv6 /64: one home, office or VPS network.', p.account.perSubnet, u),
      limitRow('Accounts per device', 'The browser device ID (localStorage, IndexedDB and a cookie).', p.account.perDevice, u),
      h(
        'div',
        { class: 'aa-row' },
        h('div', { class: 'aa-label' }, checkbox(p.account.deviceLifetime.on, 'Lifetime cap per device', (v) => (p.account.deviceLifetime.on = v)), h('div', { class: 'dim small' }, 'Accounts ever made on one device.')),
        num(p.account.deviceLifetime.count, 'Lifetime cap', 0, 100000, (v) => (p.account.deviceLifetime.count = v)),
      ),
      h(
        'div',
        { class: 'aa-row' },
        h(
          'div',
          { class: 'aa-label' },
          checkbox(p.fingerprintWithSubnet, 'Fingerprint + subnet counts as the same device', (v) => (p.fingerprintWithSubnet = v)),
          h('div', { class: 'dim small' }, 'The browser fingerprint is a soft signal: many machines share one, so it never blocks alone. With this on, the same fingerprint from the same subnet counts toward the device limits (catches a cleared device ID). It always shows under Linked accounts.'),
        ),
      ),
    ),
    card(
      'Character limits',
      limitRow('Characters per account', 'e.g. 1 per 1 hours, 1 per 1 days, 1 per 1 weeks.', p.character.perAccount, u),
      limitRow('Characters per device', 'The device of the account\'s latest login.', p.character.perDevice, u),
      limitRow('Characters per IP', 'The address of the game connection.', p.character.perIp, u),
      h('div', { class: 'aa-row' }, checkbox(p.character.countDeleted, 'Deleted characters still count (delete-and-recreate does not dodge the limit)', (v) => (p.character.countDeleted = v))),
      h('p', { class: 'dim small' }, 'GMs and admins are never limited.'),
    ),
    card(
      'VPN, proxy and hosting detection',
      h('p', { class: 'dim small' }, `Bundled lists: ${info.lists.hosting} hosting ranges, ${info.lists.tor} Tor exits (pnpm antialt:update refreshes them). Flagged and blocked attempts go to the log below.`),
      modeRow('Hosting / datacenter ranges', 'Cloud and VPS providers: where most VPNs and bots live.', 'hosting'),
      modeRow('Tor exit nodes', 'The Tor Project\'s exit list.', 'tor'),
      modeRow('External lookup', info.env.lookupProvider ? `Provider: ${info.env.lookupProvider}.` : 'No provider configured (ANTIALT_LOOKUP=proxycheck and PROXYCHECK_KEY in the server environment): this does nothing.', 'external'),
    ),
    card(
      'Robot check and other',
      h(
        'div',
        { class: 'aa-row' },
        checkbox(p.captcha, 'Cloudflare Turnstile on register', (v) => (p.captcha = v)),
        info.env.captchaConfigured ? badge('keys set', 'ok') : badge('needs TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY', 'bad'),
      ),
      h('div', { class: 'aa-row' }, checkbox(p.exemptLoopback, 'This machine (127.0.0.1, ::1) skips every limit (bots, benches, tests)', (v) => (p.exemptLoopback = v))),
      h('div', { class: 'aa-row' }, h('div', { class: 'aa-label' }, h('strong', null, 'Keep the log (days)'), h('div', { class: 'dim small' }, 'Blocked/flagged log rows and login records older than this are deleted.')), num(p.logDays, 'Log days', 1, 3650, (v) => (p.logDays = v))),
      h(
        'p',
        { class: 'dim small' },
        info.env.trustProxy
          ? `Client address: from ${info.env.clientIpHeader} when the request comes from a trusted proxy (${info.env.trustedProxies}); spoofed headers from anyone else are ignored.`
          : 'Client address: the socket address (TRUST_PROXY is off; behind Caddy set TRUST_PROXY=true).',
      ),
      h('div', { class: 'actions' }, save, reset),
    ),
  )
}

function logCard(rows: LogRow[], reload: () => void): HTMLElement {
  const lift = async (r: LogRow) => {
    if (!(await confirmDialog({ title: 'Lift this block', message: r.reason.startsWith('detect.') || r.reason === 'captcha' ? `Put ${r.ip} on the allowlist?` : 'Stop counting the events that filled this limit, so the next try passes?', confirm: 'Lift' }))) return
    if (await attempt(() => post<{ message: string }>('antialt/lift', { id: r.id }), 'Lifted.')) reload()
  }
  const allowDevice = async (r: LogRow) => {
    if (await attempt(() => post('antialt/allow', { kind: 'device', value: r.device, note: `from log #${r.id}` }), 'Device allowlisted.')) reload()
  }
  return card(
    `Blocked and flagged attempts (${rows.length})`,
    rows.length === 0
      ? emptyState('Nothing blocked or flagged yet.')
      : table(
          ['Time', 'Action', 'Outcome', 'Reason', 'Account', 'IP', 'Subnet', 'Device', ''],
          rows.map((r) =>
            h(
              'tr',
              null,
              h('td', { title: fmtTime(r.at) }, fmtAgo(r.at)),
              h('td', null, r.action),
              h('td', null, badge(r.lifted ? 'lifted' : r.outcome, r.lifted ? 'dim' : r.outcome === 'blocked' ? 'bad' : 'gold')),
              h('td', { title: r.detail }, REASON_TEXT[r.reason] ?? r.reason, r.detail ? h('div', { class: 'dim small' }, r.detail) : null),
              h('td', null, r.account),
              h('td', null, h('code', null, r.ip)),
              h('td', null, h('code', null, r.subnet)),
              h('td', null, r.device ? h('code', { title: r.device }, r.device.slice(0, 10)) : h('span', { class: 'dim' }, 'none')),
              h('td', null, r.outcome === 'blocked' && !r.lifted ? button('Lift', () => void lift(r), 'small') : null, r.device ? button('Allow device', () => void allowDevice(r), 'small') : null),
            ),
          ),
        ),
  )
}

function allowCard(rows: AllowRow[], reload: () => void): HTMLElement {
  const add = async () => {
    const v = await formDialog({
      title: 'Add to the allowlist',
      intro: 'An allowlisted IP, subnet or device skips every limit and detection (the robot check still applies).',
      fields: [
        { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'ip', label: 'IP address' }, { value: 'subnet', label: 'Subnet (CIDR, e.g. 203.0.113.0/24)' }, { value: 'device', label: 'Device (hash from the log)' }] },
        { name: 'value', label: 'Value', required: true, maxlength: 64 },
        { name: 'note', label: 'Note', maxlength: 200 },
      ],
      submit: 'Add',
      onSubmit: (vals) => post('antialt/allow', { kind: vals.kind, value: vals.value, note: vals.note }),
    })
    if (v) reload()
  }
  const remove = async (r: AllowRow) => {
    if (!(await confirmDialog({ title: 'Remove', message: `Remove ${r.kind} ${r.value} from the allowlist?`, confirm: 'Remove', danger: true }))) return
    if (await attempt(() => post('antialt/allow/delete', { id: r.id }), 'Removed.')) reload()
  }
  return card(
    'Allowlist',
    h('div', { class: 'actions' }, button('Add…', () => void add(), 'small')),
    rows.length === 0
      ? emptyState('No entries.')
      : table(
          ['Kind', 'Value', 'Note', 'Added', ''],
          rows.map((r) => h('tr', null, h('td', null, r.kind), h('td', null, h('code', null, r.value)), h('td', null, r.note), h('td', null, `${fmtAgo(r.added_at)} by ${r.added_by}`), h('td', null, button('Remove', () => void remove(r), 'small')))),
        ),
  )
}

export function antiAltPage(root: HTMLElement): void {
  root.append(pageHeader({ text: 'Registration & anti-alt', icon: svgIcon('shield') }, 'Account and character limits, VPN / hosting detection, the robot check, the log and the allowlist.'))
  const top = h('div')
  const log = h('div')
  const allow = h('div')
  root.append(top, log, allow)
  let info: Info | null = null
  const showPolicy = (p?: Policy) => {
    if (!info) return
    if (p) info = { ...info, policy: p }
    clear(top, policyCard(info, showPolicy))
  }
  const loadLists = async () => {
    try {
      const [l, a] = await Promise.all([get<{ log: LogRow[] }>('antialt/log?limit=300'), get<{ allow: AllowRow[] }>('antialt/allow')])
      clear(log, logCard(l.log, () => void loadLists()))
      clear(allow, allowCard(a.allow, () => void loadLists()))
    } catch (e) {
      clear(log, emptyState(errorText(e), 'alert', true))
    }
  }
  void (async () => {
    try {
      info = await get<Info>('antialt')
      showPolicy()
    } catch (e) {
      clear(top, emptyState(`${errorText(e)}\n(An older server without anti-alt?)`, 'alert', true))
    }
  })()
  void loadLists()
}

/** Accounts page: the accounts that share a device, IP, subnet or fingerprint with this one. */
export function linkedCard(accountId: number): HTMLElement {
  const body = h('div', null, h('p', { class: 'dim' }, 'Loading…'))
  void get<{ linked: LinkedRow[] }>(`antialt/linked/${accountId}`)
    .then(({ linked }) => {
      const sig = (r: LinkedRow) =>
        [r.device ? badge('same device', 'bad') : null, r.ip ? badge('same IP', 'gold') : null, r.fp ? badge('same fingerprint (weak)', 'info') : null, r.subnet ? badge('same subnet', 'dim') : null].filter(
          (x): x is HTMLElement => !!x,
        )
      clear(
        body,
        linked.length === 0
          ? h('p', { class: 'dim' }, 'No other account shares a device, IP, subnet or fingerprint with this one.')
          : table(
              ['Account', 'Shares', 'Last seen'],
              linked.map((r) => h('tr', null, h('td', null, h('a', { class: 'link', href: `#/accounts/${r.account_id}` }, r.username)), h('td', null, sig(r)), h('td', null, fmtAgo(r.last)))),
            ),
      )
    })
    .catch((e) => clear(body, h('p', { class: 'dim' }, errorText(e))))
  return card('Linked accounts (possible alts)', body)
}
