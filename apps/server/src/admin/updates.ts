import type { AdminUpdatesView } from '@sro/shared'
import { UpdateError, type Updater } from '../updater/updater.ts'
import type { AdminCall } from './call.ts'
import { AdminError, bad, body, conflict, isObj } from './http.ts'

/**
 * The Updates page (docs/UPDATES.md §5, docs/ADMIN.md §3): GET the view; settings, check, install, cancel and
 * rollback. Every write is audited (updates.*).
 */

function updaterOf(c: AdminCall): Updater {
  const u = c.ctx.updater
  if (!u) throw new AdminError(409, 'bad_request', 'The updater does not run in this server (only the real server process, src/main.ts, has one).')
  return u
}

const failed = (e: unknown): AdminError => (e instanceof AdminError ? e : conflict(e instanceof UpdateError ? e.message : `The updater failed: ${(e as Error).message}`))

export function updatesView(c: AdminCall): Promise<AdminUpdatesView> {
  return updaterOf(c).view()
}

export async function putUpdateSettings(c: AdminCall): Promise<AdminUpdatesView> {
  const u = updaterOf(c)
  const o = body(await c.body(), ['values'])
  if (!isObj(o.values) || Object.keys(o.values).length === 0) throw bad('values must be an object of settings')
  const r = u.saveSettings(o.values)
  if ('problems' in r) {
    c.audit('updates.settings', 'updates', undefined, o.values, false, r.problems.join('; ').slice(0, 500))
    throw bad(r.problems.join('; '))
  }
  c.audit('updates.settings', 'updates', r.before, r.after)
  c.ctx.config.log(`admin ${c.admin.username}: update settings mode=${r.after.mode} every ${r.after.intervalMin} min${r.after.windowEnabled ? ` window ${r.after.windowStart}-${r.after.windowEnd}` : ''}`)
  return u.view()
}

/** Starts a check (git fetch may take a while); the page polls the view. */
export async function checkUpdates(c: AdminCall): Promise<{ checking: true }> {
  const u = updaterOf(c)
  body((await c.body()) ?? {}, [])
  c.audit('updates.check', 'updates', undefined, undefined, true)
  void u.check()
  return { checking: true }
}

export async function installUpdate(c: AdminCall): Promise<AdminUpdatesView> {
  const u = updaterOf(c)
  body((await c.body()) ?? {}, [])
  try {
    const s = await u.install(c.admin.username)
    c.audit('updates.install', `commit:${s.to.slice(0, 12)}`, { commit: s.from }, { commit: s.to }, true, `${c.ctx.sockets.size} online`)
  } catch (e) {
    c.audit('updates.install', 'updates', undefined, undefined, false, (e as Error).message.slice(0, 500))
    throw failed(e)
  }
  return u.view()
}

export async function cancelUpdate(c: AdminCall): Promise<AdminUpdatesView> {
  const u = updaterOf(c)
  body((await c.body()) ?? {}, [])
  try {
    const run = u.cancel(c.admin.username)
    c.audit('updates.cancel', `commit:${run.to.slice(0, 12)}`, undefined, undefined, true)
  } catch (e) {
    throw failed(e)
  }
  return u.view()
}

export async function rollbackUpdate(c: AdminCall): Promise<AdminUpdatesView> {
  const u = updaterOf(c)
  body((await c.body()) ?? {}, [])
  try {
    const s = await u.rollback(c.admin.username)
    c.audit('updates.rollback', `commit:${s.to.slice(0, 12)}`, { commit: s.from }, { commit: s.to, restoresDatabase: s.restore !== null }, true)
  } catch (e) {
    c.audit('updates.rollback', 'updates', undefined, undefined, false, (e as Error).message.slice(0, 500))
    throw failed(e)
  }
  return u.view()
}
