import type { AdminUpdateRun, AdminUpdateSettings, AdminUpdatesView, UpdateMode, UpdatePhase } from '@sro/shared'
import { get, post, put } from '../api.ts'
import { attempt, badge, button, card, cardHead, clear, confirmDialog, emptyState, errorText, fmtAgo, fmtTime, h, kv, pageHeader, toast } from '../ui.ts'

/**
 * Updates (docs/UPDATES.md): which version runs, what is new on GitHub, the mode (off / notify / install
 * automatically), the check interval and install window, Check now / Update now, the progress and log of a run, the
 * history and the rollback of the last update. Polls every 3 s while something happens, else every 30 s.
 */

const MODE_LABEL: Record<UpdateMode, string> = { off: 'Off', notify: 'Notify only', auto: 'Install automatically' }
const STEPS: { phase: UpdatePhase; label: string }[] = [
  { phase: 'countdown', label: 'Countdown' },
  { phase: 'backup', label: 'Backup' },
  { phase: 'handoff', label: 'Restart' },
  { phase: 'merging', label: 'Download' },
  { phase: 'installing', label: 'Install' },
  { phase: 'building', label: 'Build' },
  { phase: 'starting', label: 'Start' },
  { phase: 'healthy', label: 'Healthy' },
]
const RESULT: Record<AdminUpdateRun['result'], [string, 'ok' | 'bad' | 'gold' | 'dim']> = {
  updated: ['updated', 'ok'],
  'rolled-back': ['rolled back', 'gold'],
  failed: ['failed', 'bad'],
  cancelled: ['cancelled', 'dim'],
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '–')

export function updatesPage(root: HTMLElement): () => void {
  const body = h('div', null, h('p', { class: 'dim' }, 'Loading…'))
  root.append(body)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** The settings form keeps what the admin typed across refreshes. */
  let editing = false
  let settingsEl: HTMLElement | null = null

  const schedule = (v: AdminUpdatesView | null) => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void load(), v && (v.state || v.checking) ? 3000 : 30_000)
  }
  const load = async () => {
    try {
      const v = await get<AdminUpdatesView>('updates')
      if (stopped) return
      render(v)
      schedule(v)
    } catch (e) {
      if (stopped) return
      clear(body, pageHeader('Updates'), emptyState(errorText(e), 'alert', true))
      // The server restarts during an update: keep trying.
      schedule({ state: null, checking: true } as unknown as AdminUpdatesView)
    }
  }

  const commitLink = (v: AdminUpdatesView, sha: string | null | undefined) =>
    sha ? h('a', { class: 'link mono', href: `${v.webUrl}/commit/${sha}`, target: '_blank', rel: 'noopener noreferrer' }, short(sha)) : '–'

  const render = (v: AdminUpdatesView) => {
    const check = button(v.checking ? 'Checking…' : 'Check now', async () => {
      if (await attempt(() => post('updates/check'))) {
        toast('Checking for updates…', 'info')
        setTimeout(() => void load(), 1500)
      }
    })
    check.disabled = v.checking || v.install === 'deployed' || v.install === 'disabled' || v.settings.mode === 'off'
    const install = button('Update now…', () => void updateNow(v), 'primary')
    install.disabled = !v.canUpdate
    if (!v.canUpdate && v.blockers.length) install.title = v.blockers.join('\n')
    clear(
      body,
      pageHeader('Updates', 'Follow the public repository: see what is new, install it with a countdown for players, roll back if it goes wrong.', check, ...(v.install === 'git' ? [install] : [])),
      h('div', { class: 'notice' }, v.installNote),
      v.warnings.map((w) => h('div', { class: 'notice warn' }, w)),
      v.state ? progressCard(v) : null,
      h('div', { class: 'grid grid-2' }, versionCard(v), editing && settingsEl ? settingsEl : (settingsEl = settingsCard(v))),
      v.install === 'zip' ? zipCard(v) : null,
      whatsNewCard(v),
      historyCard(v),
    )
  }

  const versionCard = (v: AdminUpdatesView) => {
    const status =
      v.install === 'zip'
        ? v.latest ? badge('see GitHub', 'info') : null
        : v.latest === null ? badge('not checked', 'dim')
        : v.ahead > 0 ? badge(`${v.ahead} local commit(s)`, 'bad')
        : v.behind > 0 ? badge(`${v.behind} new commit(s)`, 'gold')
        : badge('up to date', 'ok')
    return card(
      null,
      cardHead('Version', status),
      kv([
        ['Running', v.current ? [commitLink(v, v.current.commit), ` ${fmtTime(v.current.date)} `, h('span', { class: 'dim' }, v.current.subject)] : h('span', { class: 'dim' }, v.install === 'git' ? 'unknown' : 'unknown (not a git clone)')],
        ['Latest', v.latest ? [commitLink(v, v.latest.commit), v.latest.date ? ` ${fmtTime(v.latest.date)} ` : ' ', h('span', { class: 'dim' }, v.latest.subject)] : h('span', { class: 'dim' }, 'not checked yet')],
        ['Repository', [h('a', { class: 'link', href: v.webUrl, target: '_blank', rel: 'noopener noreferrer' }, v.webUrl.replace(/^https:\/\//, '')), ` (${v.settings.branch})`]],
        ['Last check', v.lastCheck ? [fmtAgo(v.lastCheck.at), ' ', v.lastCheck.ok ? badge('ok', 'ok') : badge('failed', 'bad'), v.lastCheck.error ? h('div', { class: 'error small pre' }, v.lastCheck.error) : null] : 'not yet'],
        ['Next check', v.checking ? 'running now' : v.nextCheckAt ? fmtAgo(v.nextCheckAt) : 'never (mode Off)'],
        ['Supervisor', v.supervised ? badge('pnpm serve', 'ok') : [badge('none', 'dim'), h('span', { class: 'dim small' }, ' installs and restarts need pnpm serve')]],
      ]),
      v.skipped ? h('p', { class: 'dim small' }, `Automatic installs skip ${short(v.skipped)} (it failed or was rolled back); Update now still installs it, and a newer commit is installed as usual.`) : null,
      v.install === 'git' && !v.canUpdate && v.behind > 0 && v.blockers.length ? h('div', { class: 'notice warn' }, h('strong', null, 'Update now is not possible: '), v.blockers.join(' ')) : null,
    )
  }

  const settingsCard = (v: AdminUpdatesView) => {
    const s = v.settings
    const mode = h('select', { class: 'input', 'aria-label': 'Mode' }, (Object.keys(MODE_LABEL) as UpdateMode[]).map((m) => h('option', { value: m, selected: m === s.mode }, MODE_LABEL[m])))
    const interval = h('input', { class: 'input num-input', type: 'number', min: 15, max: 1440, step: 1, value: String(s.intervalMin), 'aria-label': 'Check every (minutes)' })
    const winOn = h('input', { type: 'checkbox', checked: s.windowEnabled, 'aria-label': 'Only install inside a time window' })
    const winText = h('span', { class: 'switch-text' }, s.windowEnabled ? 'On' : 'Off')
    winOn.addEventListener('change', () => (winText.textContent = winOn.checked ? 'On' : 'Off'))
    const start = h('input', { class: 'input', type: 'time', value: s.windowStart, 'aria-label': 'Window start' })
    const end = h('input', { class: 'input', type: 'time', value: s.windowEnd, 'aria-label': 'Window end' })
    const tz = h('input', { class: 'input', type: 'text', value: s.windowTz, placeholder: v.serverTz, maxlength: 64, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Window time zone' })
    const repo = h('input', { class: 'input', type: 'url', value: s.repoUrl, maxlength: 300, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Repository URL' })
    const branch = h('input', { class: 'input', type: 'text', value: s.branch, maxlength: 100, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Branch' })
    const form = h('div', { class: 'settings' })
    for (const el of [mode, interval, winOn, start, end, tz, repo, branch]) el.addEventListener('input', () => (editing = true))
    const row = (label: string, control: HTMLElement, note?: string) =>
      h('div', { class: 'setting' }, h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, label)), h('div', { class: 'setting-control' }, control), note ? h('div', { class: 'setting-note dim small' }, note) : null)
    clear(
      form,
      row('Mode', mode, 'Notify only (default): checks and shows what is new here. Install automatically: also installs it (players get a 5-minute countdown; at once when nobody is online).'),
      row('Check every (minutes)', interval),
      row('Install window', h('label', { class: 'switch' }, winOn, h('span', { class: 'switch-track' }), winText), 'On: automatic installs only between the times below. Update now works any time.'),
      row('Window', h('div', { class: 'inline-form' }, start, h('span', { class: 'dim' }, 'to'), end), 'May wrap midnight (22:00 to 06:00).'),
      row('Window time zone', tz, `Empty: the server's own (${v.serverTz}).`),
      row('Repository', repo, 'origin of this clone must be this https URL; otherwise the updater stays off.'),
      row('Branch', branch),
    )
    const save = button('Save', async () => {
      const values: Partial<AdminUpdateSettings> = {
        mode: mode.value as UpdateMode, intervalMin: Number(interval.value), windowEnabled: winOn.checked, windowStart: start.value, windowEnd: end.value,
        windowTz: tz.value.trim(), repoUrl: repo.value.trim(), branch: branch.value.trim(),
      }
      if (values.mode === 'auto' && s.mode !== 'auto' && !(await confirmDialog({ title: 'Install updates automatically', message: 'New commits on GitHub will be installed without asking: a database backup, a 5-minute countdown for players, a restart of a few minutes. A version that does not come up is rolled back.', confirm: 'Turn on' }))) return
      const r = await attempt(() => put<AdminUpdatesView>('updates/settings', { values }), 'Update settings saved.')
      if (r) {
        editing = false
        render(r)
      }
    }, 'primary')
    return card(null, cardHead('Settings', badge(MODE_LABEL[s.mode], s.mode === 'auto' ? 'gold' : s.mode === 'off' ? 'dim' : 'info')), form, h('div', { class: 'actions end' }, save))
  }

  const progressCard = (v: AdminUpdatesView) => {
    const st = v.state!
    const at = STEPS.findIndex((x) => x.phase === st.phase)
    const steps = h('ol', { class: 'steps', 'aria-label': 'Progress' }, STEPS.map((x, i) => h('li', { class: st.phase === 'rolling-back' ? '' : i < at ? 'done' : i === at ? 'now' : '' }, x.label)))
    const left = st.countdownEndsAt ? st.countdownEndsAt - Date.now() : 0
    const cancel = st.phase === 'countdown' || st.phase === 'backup' ? button('Cancel update', async () => {
      if (!(await confirmDialog({ title: 'Cancel the update', message: 'Players are told the update is called off; nothing was changed yet.', confirm: 'Cancel update', danger: true }))) return
      const r = await attempt(() => post<AdminUpdatesView>('updates/cancel'), 'Update cancelled.')
      if (r) render(r)
    }, 'danger') : null
    return card(
      null,
      cardHead(st.kind === 'update' ? `Updating ${short(st.from)} → ${short(st.to)}` : `Rolling back ${short(st.from)} → ${short(st.to)}`, st.phase === 'rolling-back' ? badge('rolling back', 'bad') : badge(st.phase, 'gold')),
      steps,
      st.phase === 'countdown' && left > 0 ? h('p', null, `Players are counting down: restart in about ${Math.ceil(left / 1000)} s.`) : null,
      ['handoff', 'merging', 'installing', 'building', 'starting'].includes(st.phase) ? h('p', { class: 'dim' }, 'The server is down while the new version is installed and built; this page reconnects by itself.') : null,
      h('p', { class: 'dim small' }, `Started ${fmtTime(st.startedAt)} by ${st.by}.`),
      h('pre', { class: 'json' }, st.log.slice(-60).join('\n') || '…'),
      cancel ? h('div', { class: 'actions' }, cancel) : null,
    )
  }

  const whatsNewCard = (v: AdminUpdatesView) => {
    if (v.install !== 'git' || v.behind === 0) return null
    return card(
      null,
      cardHead("What's new", badge(`${v.behind} commit(s)`, 'gold')),
      v.changelog.length
        ? v.changelog.map((e) => h('div', { class: 'update-entry' }, h('h4', null, e.title), h('div', { class: 'dim small' }, e.date), h('p', null, e.summary)))
        : h('p', { class: 'dim' }, 'No new "What\'s new" entry; the commits are below.'),
      h('details', null, h('summary', null, `Commits (${v.commits.length}${v.behind > v.commits.length ? ` of ${v.behind}` : ''})`), h('ul', { class: 'timeline' }, v.commits.map((c) => h('li', null, commitLink(v, c.commit), ' ', c.subject, h('span', { class: 'dim small' }, ` · ${c.author} · ${fmtTime(c.date)}`))))),
    )
  }

  const zipCard = (v: AdminUpdatesView) =>
    card(
      'Switch to a git clone to get automatic updates',
      h('p', null, 'This server was installed from a ZIP, so it cannot tell which version it runs or update itself. ', v.latest ? ['The latest commit on GitHub is ', commitLink(v, v.latest.commit), '. '] : null, h('a', { class: 'link', href: v.webUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open the repository'), '.'),
      h('p', null, 'Once: clone the repository next to this folder, move your data over, and start it with pnpm serve (docs/UPDATES.md, "From a ZIP to a git clone"):'),
      h('pre', { class: 'json' }, `git clone ${v.settings.repoUrl}.git silkroad\ncd silkroad\ngit config core.longpaths true\npnpm install --frozen-lockfile\n# copy work/server (your database) from the old folder, then:\npnpm serve`),
    )

  const historyCard = (v: AdminUpdatesView) => {
    const rb = v.rollback
      ? button('Roll back…', async () => {
          const r0 = v.rollback!
          const ok = await confirmDialog({
            title: 'Roll back the last update',
            message: `Back to ${short(r0.to)} (the version before the update of ${fmtTime(r0.at)}). Players get the countdown, the server restarts for a few minutes.${r0.restoresDatabase ? `\n\nThat update changed the database, so its backup is restored too: progress made since ${fmtTime(r0.at)} is lost.` : ''}\n\nAutomatic installs then skip that update until a newer commit arrives.`,
            confirm: 'Roll back',
            danger: true,
          })
          if (!ok) return
          const r = await attempt(() => post<AdminUpdatesView>('updates/rollback'), 'Rollback started.')
          if (r) render(r)
        }, 'danger')
      : null
    return card(
      null,
      cardHead('History', rb),
      v.history.length === 0
        ? h('p', { class: 'dim' }, 'No update has run on this server yet.')
        : h(
            'div',
            { class: 'stack' },
            v.history.map((r) =>
              h(
                'details',
                null,
                h('summary', null, badge(...RESULT[r.result]), ` ${r.kind === 'rollback' ? 'Rollback' : 'Update'} ${short(r.from)} → ${short(r.to)} · ${fmtTime(r.startedAt)} · ${r.by}`, r.reason ? h('span', { class: 'dim' }, ` · ${r.reason}`) : null),
                r.backup ? h('p', { class: 'dim small mono' }, `Backup: ${r.backup}`) : null,
                h('pre', { class: 'json' }, r.log.join('\n')),
              ),
            ),
          ),
    )
  }

  const updateNow = async (v: AdminUpdatesView) => {
    const ok = await confirmDialog({
      title: 'Install the update',
      message: `${v.behind} new commit(s), ${short(v.current?.commit)} → ${short(v.latest?.commit)}.\n\nA database backup is made, players get a 5-minute countdown (none when nobody is online), then the server restarts, installs and builds the new version (a few minutes). If it does not come up healthy it is rolled back by itself.`,
      confirm: 'Update now',
    })
    if (!ok) return
    const r = await attempt(() => post<AdminUpdatesView>('updates/install'), 'Update started.')
    if (r) {
      render(r)
      schedule(r)
    }
  }

  void load()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
