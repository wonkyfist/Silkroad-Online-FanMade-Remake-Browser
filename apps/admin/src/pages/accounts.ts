import { ADMIN_BAN_REASON_MAX, type AdminAccountDetail, type AdminAccountRow, type AdminPage } from '@sro/shared'
import { get, post, qs } from '../api.ts'
import { attempt, badge, button, card, clear, confirmDialog, dataTable, errorText, fmtAgo, fmtNum, fmtTime, formDialog, h, kv, navigate, pageHeader } from '../ui.ts'
import { storageCard } from './characters.ts'
import { svgIcon } from '../icons.ts'

/** Accounts: search, create (also while registration is closed), password, ban / unban, kick, characters, storage. */
export function accountsPage(root: HTMLElement): void {
  const role = h('select', { class: 'input', 'aria-label': 'Role' }, [['', 'Any role'], ['player', 'Players'], ['gm', 'GMs'], ['admin', 'Admins']].map(([v, l]) => h('option', { value: v }, l)))
  const banned = h('select', { class: 'input', 'aria-label': 'Banned' }, [['', 'Banned or not'], ['1', 'Banned'], ['0', 'Not banned']].map(([v, l]) => h('option', { value: v }, l)))
  const table = dataTable<AdminAccountRow>({
    placeholder: 'Search accounts',
    filters: [role, banned],
    load: (q, page, size) => get<AdminPage<AdminAccountRow>>(`accounts${qs({ q, page, size, role: role.value, banned: banned.value })}`),
    onRow: (r) => navigate(`accounts/${r.id}`),
    columns: [
      { label: 'Account', render: (r) => [h('strong', null, r.username), r.role !== 'player' ? badge(r.role.toUpperCase(), 'gold') : null] },
      { label: 'Status', render: (r) => [r.online ? badge('online', 'ok') : badge('offline'), r.banned ? badge('banned', 'bad') : null] },
      { label: 'Characters', render: (r) => String(r.characters), class: 'num' },
      { label: 'Last login', render: (r) => fmtAgo(r.lastLogin) },
      { label: 'Created', render: (r) => fmtTime(r.createdAt) },
    ],
  })
  for (const s of [role, banned]) s.addEventListener('change', () => void table.reload())
  const create = button('New account…', async () => {
    let made: AdminAccountDetail | null = null
    const v = await formDialog({
      title: 'Create an account',
      intro: 'Works while public registration is closed. New accounts are players; GM and admin roles are granted with pnpm deploy:gm grant.',
      fields: [
        { name: 'username', label: 'Account name', required: true, maxlength: 16, hint: '3-16 letters, digits or _' },
        { name: 'password', label: 'Password', type: 'password', required: true, maxlength: 64, hint: '6-64 characters' },
      ],
      submit: 'Create',
      onSubmit: async (vals) => {
        made = await post<AdminAccountDetail>('accounts', { username: String(vals.username).trim(), password: vals.password })
      },
    })
    if (v && made) {
      navigate(`accounts/${(made as AdminAccountDetail).id}`)
    }
  }, 'primary')
  root.append(pageHeader('Accounts', 'Everyone who can log in.', create), card(null, table.root))
}

export function accountPage(root: HTMLElement, args: string[]): void {
  const id = Number(args[0])
  const body = h('div')
  root.append(body)
  const load = async () => {
    try {
      render(await get<AdminAccountDetail>(`accounts/${id}`))
    } catch (e) {
      clear(body, pageHeader('Account'), h('p', { class: 'error' }, errorText(e)))
    }
  }
  const render = (a: AdminAccountDetail) => {
    const act = (fn: () => Promise<unknown>, ok: string) => async () => {
      if (await attempt(fn, ok)) void load()
    }
    const password = button('Reset password…', async () => {
      const v = await formDialog({
        title: `New password for ${a.username}`,
        danger: true,
        intro: 'Their game sessions end and they are disconnected.',
        fields: [{ name: 'password', label: 'New password', type: 'password', required: true, maxlength: 64, hint: '6-64 characters' }],
        submit: 'Set password',
        onSubmit: (vals) => post(`accounts/${a.id}/password`, { password: vals.password }),
      })
      if (v) void act(async () => true, 'Password changed.')()
    })
    const ban = a.banned
      ? button('Unban', async () => {
          if (await confirmDialog({ title: 'Unban', message: `Let ${a.username} log in again?`, confirm: 'Unban' })) void act(() => post(`accounts/${a.id}/unban`), `${a.username} is unbanned.`)()
        })
      : button('Ban…', async () => {
          const v = await formDialog({
            title: `Ban ${a.username}`,
            intro: 'They are disconnected at once and cannot log in until unbanned. They see the reason.',
            fields: [{ name: 'reason', label: 'Reason', required: true, maxlength: ADMIN_BAN_REASON_MAX }],
            submit: 'Ban',
            danger: true,
            onSubmit: (vals) => post(`accounts/${a.id}/ban`, { reason: vals.reason }),
          })
          if (v) void act(async () => true, `${a.username} is banned.`)()
        }, 'danger')
    const kick = a.online
      ? button('Kick…', async () => {
          const v = await formDialog({ title: `Kick ${a.username}`, fields: [{ name: 'reason', label: 'Reason (optional)', maxlength: 100 }], submit: 'Kick', danger: true })
          if (v) void act(() => post(`accounts/${a.id}/kick`, { reason: String(v.reason).trim() || undefined }), `${a.username} was kicked.`)()
        })
      : null
    clear(
      body,
      pageHeader({ text: a.username, icon: svgIcon('accounts') }, `Account #${a.id}`, ...[kick, password, ban].filter((x): x is HTMLButtonElement => !!x)),
      h(
        'div',
        { class: 'grid grid-2' },
        card(
          'Account',
          kv([
            ['Role', [badge(a.role.toUpperCase(), a.role === 'player' ? 'dim' : 'gold'), h('span', { class: 'dim small' }, ' changed only with pnpm deploy:gm grant / revoke')]],
            ['Status', a.online ? badge('online', 'ok') : badge('offline')],
            ['Banned', a.banned ? [badge('banned', 'bad'), ` ${a.banned.reason} (by ${a.banned.by}, ${fmtTime(a.banned.at)})`] : 'no'],
            ['Created', fmtTime(a.createdAt)],
            ['Last login', fmtAgo(a.lastLogin)],
          ]),
        ),
        card(
          `Characters (${a.characterList.length})`,
          a.characterList.length === 0
            ? h('p', { class: 'dim' }, 'No characters.')
            : h(
                'ul',
                { class: 'list' },
                a.characterList.map((c) => h('li', null, h('a', { class: 'link', href: `#/characters/${c.id}` }, c.name), ` Lv ${c.level} `, c.online ? badge('in the world', 'ok') : h('span', { class: 'dim small' }, `last played ${fmtAgo(c.lastPlayed || null)}`))),
              ),
        ),
      ),
      storageCard(a.id, a.storage, load),
      h('p', { class: 'dim small' }, `Storage gold: ${fmtNum(a.storage.gold)}.`),
    )
  }
  void load()
}
