import type { GmResult } from '../gm.ts'
import type { Player } from '../world.ts'
import type { Pilot } from './service.ts'

/**
 * `/unique pilot ...` (docs/PLAY_THE_BOSS.md §2.5): a sub-command of the `unique` GM row, so gm.ts audits it like every
 * GM command (gm_audit). The admin panel's routes (admin.ts) call the same service functions.
 *
 * - `pilot <name>` / `pilot pick <name>`: offers the turn to `<name>` now (consent asked; 30 s); during a call it
 *   closes the call (a force-pick);
 * - `pilot start [minutes]`: opens a call for volunteers now (1–60 min, default the setting);
 * - `pilot stop`: cancels the current event at any phase (or ends an attach session);
 * - `pilot status`: phase, timers, pilot, steering, downs, hunters, her HP;
 * - `pilot attach <name>` / `pilot detach`: layer 1's test tool, steering the living unique with no event rules;
 * - `pilot block <name> <days> [reason]` / `pilot unblock <name>`: the lottery blocks (the character's account).
 *
 * The words start, stop, status, attach, detach, block, unblock and pick are reserved: a character with such a name is
 * picked with `pilot pick <name>`.
 */
export const PILOT_USAGE =
  'unique pilot <name> | pilot pick <name> | pilot start [minutes] | pilot stop | pilot status | pilot attach <name> | pilot detach | pilot block <name> <days> [reason] | pilot unblock <name>'

export function pilotGm(s: Pilot, self: Player | null, args: string[], now: number): GmResult {
  const words = args.join(' ').trim().split(/\s+/).filter(Boolean)
  const sub = (words[0] ?? '').toLowerCase()
  const rest = words.slice(1)
  const who = self?.name ?? 'a GM'
  switch (sub) {
    case '':
      return { ok: false, message: `Usage: ${PILOT_USAGE}` }
    case 'status': {
      const st = s.status(now)
      return { ok: true, message: st.text, data: st.data }
    }
    case 'stop': {
      const r = s.stop(rest.join(' '), who, now)
      return r.ok ? { ok: true, message: r.message, data: { event: r.event } } : { ok: false, message: r.message }
    }
    case 'attach': {
      if (rest.length !== 1) return { ok: false, message: 'Usage: unique pilot attach <name>' }
      const r = s.attach('', rest[0], now)
      return { ok: r.ok, message: r.message }
    }
    case 'detach': {
      const r = s.detach(now)
      return { ok: r.ok, message: r.message }
    }
    case 'start': {
      if (rest.length > 1 || (rest.length === 1 && !/^\d{1,2}$/.test(rest[0]))) return { ok: false, message: 'Usage: unique pilot start [minutes 1-60]' }
      const r = s.startCall('', rest.length ? Number(rest[0]) : undefined, 'gm', now)
      return r.ok ? { ok: true, message: r.message, data: { event: r.event.id, callEndsAt: r.event.callEndsAt } } : { ok: false, message: r.message }
    }
    case 'block': {
      const days = Number(rest[1])
      if (rest.length < 2 || !(days > 0)) return { ok: false, message: 'Usage: unique pilot block <name> <days> [reason]' }
      const r = s.lottery.block(rest[0], days, rest.slice(2).join(' '), self ? s.accountOf(self.characterId) : null, now)
      return r.ok ? { ok: true, message: r.message, data: { account: r.account } } : { ok: false, message: r.message }
    }
    case 'unblock': {
      if (rest.length !== 1) return { ok: false, message: 'Usage: unique pilot unblock <name>' }
      const r = s.lottery.unblock(rest[0])
      return r.ok ? { ok: true, message: r.message, data: { account: r.account } } : { ok: false, message: r.message }
    }
    case 'pick':
      if (rest.length !== 1) return { ok: false, message: 'Usage: unique pilot pick <name>' }
      return pick(s, rest[0], now)
    default:
      if (words.length !== 1) return { ok: false, message: `Usage: ${PILOT_USAGE}` }
      return pick(s, words[0], now)
  }
}

function pick(s: Pilot, name: string, now: number): GmResult {
  const r = s.pick('', name, 'gm', now)
  return r.ok ? { ok: true, message: r.message, data: { event: r.event.id } } : { ok: false, message: r.message }
}
