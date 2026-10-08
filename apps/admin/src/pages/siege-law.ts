import type { AdminLawView } from '@sro/shared'
import { get, post } from '../api.ts'
import { attempt, badge, button, card, cardHead, clear, confirmDialog, emptyState, errorText, fmtAgo, fmtDuration, fmtNum, fmtTime, formDialog, h, stackTable } from '../ui.ts'

/**
 * Siege of Jangan, layer 6: the Law tab of the siege page (docs/SIEGE.md §11.4 item 5). Open warrants (pardon), the
 * Garrison Stockade (add time, release, jail someone), the offence records per account (forgive one level or all),
 * the Hunters (revoke, restore), the capture rewards withheld by the anti-collusion rules (suspected collusion, with a
 * revoke button) and the latest warrants with their captors. Every button posts to
 * `/api/admin/siege/law/*` (law-admin.ts on the server), which writes a gm_audit row.
 */

const STATUS_KIND: Record<string, 'ok' | 'bad' | 'dim' | 'info' | 'gold'> = { open: 'bad', captured: 'gold', lapsed: 'dim', pardoned: 'info' }
const RULE_TEXT: Record<string, string> = {
  associate: 'associate (party, guild, account, IP)',
  contact: 'recent contact (trade, stall, party)',
  lookout: 'lookout at the keg',
  pair: 'same pair within the cooldown',
  repeat: 'Wanted caught repeatedly',
  daily_cap: 'daily bounty cap',
}
const RANKS = ['Recruit', 'Tracker', 'Bloodhound', 'Manhunter', 'Bounty Sergeant', 'Bounty Captain']

function table(heads: string[], rows: HTMLElement[]): HTMLElement {
  return h('div', { class: 'table-scroll' }, stackTable(h('table', { class: 'table' }, h('thead', null, h('tr', null, heads.map((x) => h('th', null, x)))), h('tbody', null, rows))))
}

export function lawTab(root: HTMLElement): void {
  const body = h('div')
  root.append(body)
  const act = async (path: string, payload: Record<string, unknown>, done: string) => {
    const r = await attempt(() => post<{ message: string; law: AdminLawView }>(`siege/law/${path}`, payload), done)
    if (r) render(r.law)
  }
  const confirmAct = async (title: string, message: string, path: string, payload: Record<string, unknown>, done: string, danger = false) => {
    if (await confirmDialog({ title, message, confirm: title, danger })) await act(path, payload, done)
  }
  const jailSomeone = async () => {
    const v = await formDialog({
      title: 'Jail a character',
      intro: 'Puts the character in the Garrison Stockade now (online: warped in; offline: at the next login). This is not an offence on the record.',
      fields: [
        { name: 'character', label: 'Character name', required: true, maxlength: 32 },
        { name: 'minutes', label: 'Minutes', type: 'number', value: 120, min: 1, max: 10_080, required: true },
        { name: 'reason', label: 'Reason (shown to the player)', maxlength: 120 },
      ],
      submit: 'Jail',
    })
    if (v) await act('jail', { character: String(v.character), minutes: Number(v.minutes), reason: String(v.reason ?? '') }, `${String(v.character)} is jailed.`)
  }

  const render = (v: AdminLawView) => {
    const now = Date.now()
    const wanted = v.wanted.length
      ? table(
          ['Wanted', 'Role', 'Wall', 'Offence', 'Bounty', 'Lapses after (online)', 'Issued', ''],
          v.wanted.map((w) =>
            h(
              'tr',
              null,
              h('td', null, w.name, ' ', w.online ? badge('online', 'ok') : badge('offline', 'dim')),
              h('td', null, w.role, w.treason ? [' ', badge('treason', 'bad')] : null),
              h('td', null, w.wall ?? '—'),
              h('td', { class: 'num' }, String(w.offence)),
              h('td', { class: 'num' }, fmtNum(w.bounty)),
              h('td', null, fmtDuration(w.onlineLeftMs)),
              h('td', null, fmtAgo(w.issuedAt, now)),
              h('td', { class: 'row-actions' }, button('Pardon', () => void confirmAct('Pardon', `Close ${w.name}'s warrants (no jail, no bounty; the offence stays on the record).`, 'pardon', { character: w.characterId }, `${w.name} is pardoned.`), 'small')),
            ),
          ),
        )
      : emptyState('Nobody is Wanted.', 'inbox')
    const jailed = v.jailed.length
      ? table(
          ['Prisoner', 'Time left', 'Release at', 'Chores', ''],
          v.jailed.map((j) =>
            h(
              'tr',
              null,
              h('td', null, j.name, ' ', j.online ? badge('online', 'ok') : badge('offline', 'dim')),
              h('td', null, fmtDuration(j.leftMs)),
              h('td', null, v.clock === 'real' ? fmtTime(j.endsAt) : 'online clock'),
              h('td', { class: 'num' }, String(j.chores)),
              h(
                'td',
                { class: 'row-actions' },
                button('+30 min', () => void act('time', { character: j.characterId, minutes: 30 }, `${j.name}: +30 min.`), 'small'),
                button('−30 min', () => void act('time', { character: j.characterId, minutes: -30 }, `${j.name}: −30 min.`), 'small'),
                button('Release', () => void confirmAct('Release', `Open the gate for ${j.name} now.`, 'release', { character: j.characterId }, `${j.name} is released.`), 'small'),
              ),
            ),
          ),
        )
      : emptyState('The Garrison Stockade is empty.', 'inbox')
    const records = v.records.length
      ? table(
          ['Account', 'Characters', 'Offence level now', 'Last offence', 'Last keg', ''],
          v.records.map((r) =>
            h(
              'tr',
              null,
              h('td', { class: 'num' }, `#${r.accountId}`),
              h('td', null, r.characters.join(', ') || '—'),
              h('td', null, `${r.level}`, r.recorded !== r.level ? h('span', { class: 'dim small' }, ` (${r.recorded} recorded)`) : null),
              h('td', null, fmtAgo(r.lastOffenceAt, now)),
              h('td', null, fmtAgo(r.lastPlantAt, now)),
              h(
                'td',
                { class: 'row-actions' },
                r.characters[0] && r.level > 0
                  ? [
                      button('Forgive one', () => void act('forgive', { character: r.characters[0] }, 'One offence level forgiven.'), 'small'),
                      button('Forgive all', () => void confirmAct('Forgive all', `Clear the offence record of account #${r.accountId}: the next sentence is a first offence again.`, 'forgive', { character: r.characters[0], all: true }, 'The record is clear.'), 'small'),
                    ]
                  : null,
              ),
            ),
          ),
        )
      : emptyState('No offences on record.', 'inbox')
    const hunters = v.hunters.length
      ? table(
          ['Bounty Hunter', 'Rank', 'Captures', 'Duty', 'Licence', ''],
          v.hunters.map((x) =>
            h(
              'tr',
              null,
              h('td', null, x.name, ' ', x.online ? badge('online', 'ok') : badge('offline', 'dim')),
              h('td', null, RANKS[x.rank] ?? String(x.rank)),
              h('td', { class: 'num' }, String(x.captures)),
              h('td', null, x.onDuty ? badge('on duty', 'info') : 'off'),
              h('td', null, x.revokedUntil ? badge(`revoked until ${fmtTime(x.revokedUntil)}`, 'bad') : badge('licensed', 'ok')),
              h(
                'td',
                { class: 'row-actions' },
                x.revokedUntil
                  ? button('Restore', () => void act('hunter', { character: x.characterId, action: 'restore' }, `${x.name}'s licence is restored.`), 'small')
                  : button('Revoke', () => void confirmAct('Revoke', `Take ${x.name}'s Bounty Hunter licence away (for the revoke days of the settings).`, 'hunter', { character: x.characterId, action: 'revoke' }, `${x.name}'s licence is revoked.`), 'small'),
              ),
            ),
          ),
        )
      : emptyState('No Bounty Hunters licensed yet (Captain Yun, west gate).', 'inbox')
    const flags = v.flags.length
      ? table(
          ['When', 'Bounty Hunter', 'Wanted', 'Rule', 'Gold withheld', ''],
          v.flags.map((f) =>
            h(
              'tr',
              null,
              h('td', null, fmtTime(f.at)),
              h('td', null, f.hunter, h('span', { class: 'dim small' }, ` (account #${f.hunterAccount ?? '?'})`)),
              h('td', null, f.wanted, h('span', { class: 'dim small' }, ` (account #${f.wantedAccount})`)),
              h('td', null, badge(RULE_TEXT[f.rule] ?? f.rule, f.rule === 'daily_cap' || f.rule === 'repeat' ? 'info' : 'bad')),
              h('td', { class: 'num' }, fmtNum(f.withheld)),
              h('td', { class: 'row-actions' }, v.hunters.some((x) => x.name === f.hunter && !x.revokedUntil) ? button('Revoke licence', () => void confirmAct('Revoke', `Take ${f.hunter}'s Bounty Hunter licence away.`, 'hunter', { character: f.hunter, action: 'revoke' }, `${f.hunter}'s licence is revoked.`), 'small') : null),
            ),
          ),
        )
      : emptyState('No capture reward was withheld.', 'inbox')
    const recent = v.recent.length
      ? table(
          ['#', 'Character', 'Status', 'Role', 'Wall', 'Offence', 'Bounty', 'Issued', 'Closed', 'Captors (gold)'],
          v.recent.map((r) =>
            h(
              'tr',
              null,
              h('td', { class: 'num' }, String(r.warrant)),
              h('td', null, r.name),
              h('td', null, badge(r.status, STATUS_KIND[r.status] ?? 'dim')),
              h('td', null, r.role),
              h('td', null, r.wall ?? '—'),
              h('td', { class: 'num' }, String(r.offence)),
              h('td', { class: 'num' }, fmtNum(r.bounty)),
              h('td', null, fmtTime(r.issuedAt)),
              h('td', null, r.closedAt ? fmtTime(r.closedAt) : '—'),
              h('td', null, r.captors.join(', ') || '—'),
            ),
          ),
        )
      : emptyState('No warrants yet.', 'inbox')
    clear(
      body,
      h('p', { class: 'dim' }, `The jail clock: ${v.clock === 'real' ? 'real time (a sentence runs offline too)' : 'online time only'}. Sentences 2 / 4 / 8 / 16 / 24 h by offence (an accomplice half; treason ×2).`),
      card(cardHead(`Wanted (${v.wanted.length})`, button('Refresh', () => void load(), 'small')), wanted),
      card(cardHead(`The Garrison Stockade (${v.jailed.length})`, button('Jail a character…', () => void jailSomeone(), 'small')), jailed),
      card(`Offence records (${v.records.length})`, records),
      card(`Bounty Hunters (${v.hunters.length})`, hunters),
      card(`Suspected collusion: withheld capture rewards (${v.flags.length})`, h('p', { class: 'dim small' }, 'Captures whose bounty or credit an anti-collusion rule refused: friends farming bounties show up here again and again.'), flags),
      card('Latest warrants', recent),
    )
  }
  const load = async () => {
    try {
      render(await get<AdminLawView>('siege/law'))
    } catch (e) {
      clear(body, emptyState(errorText(e), 'alert', true))
    }
  }
  void load()
}
