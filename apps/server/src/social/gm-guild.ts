import type { GmCall, GmResult } from '../gm.ts'

/**
 * GM `guilds` (docs/SYSTEMS_SOCIAL.md §5.6 G2, §10.7; lane GU-S): list, info, rename, disband a guild and expel one of
 * its members. Named `guilds`, never `guild`: the client's `/guild` chat prefix (an invite) claims those lines before
 * the GM path. Staff only and audited, like every GM command (gm.ts runGm). A GM disband starts no recreate clock and a
 * GM expel no rejoin clock; expelling the master hands the guild to the member who joined earliest.
 */

export const GUILDS_USAGE = 'guilds list | guilds info <name> | guilds rename <old> <new> | guilds disband <name> | guilds kick <guild> <character>'

const ok = (message: string, data?: unknown): GmResult => (data === undefined ? { ok: true, message } : { ok: true, message, data })
const no = (message: string): GmResult => ({ ok: false, message })

function when(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'never'
}

export function runGuildsCommand({ ctx, args }: GmCall): GmResult {
  const guilds = ctx.gameplay.guilds
  const [sub, a, b] = args
  const usage = no(`Usage: ${GUILDS_USAGE}`)
  switch ((sub ?? '').toLowerCase()) {
    case 'list': {
      if (args.length !== 1) return usage
      const rows = guilds.store.liveGuilds()
      if (rows.length === 0) return ok('No guilds.')
      const lines = rows.map((r) => `${r.name} (id ${r.id}): ${r.members} member${r.members === 1 ? '' : 's'}, master ${ctx.store.characterById(r.master_id)?.name ?? r.master_id}`)
      return ok(`${rows.length} guild${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`, rows.map((r) => ({ id: r.id, name: r.name, members: r.members })))
    }
    case 'info': {
      if (args.length !== 2) return usage
      const g = guilds.guildNamed(a)
      if (!g) return no(`No guild named ${a}.`)
      const st = guilds.state(g)
      const members = st.members.map((m) => {
        const extra = [m.rank === 'master' ? 'Master' : '', m.perms.length && m.rank !== 'master' ? m.perms.join('/') : '', m.title ? `"${m.title}"` : '']
          .filter(Boolean)
          .join(', ')
        return `  ${m.name} Lv ${m.level} ${m.online ? 'online' : `last seen ${when(m.lastSeen)}`}${extra ? ` [${extra}]` : ''}`
      })
      const notice = st.notice.title || st.notice.text ? `\nNotice: ${st.notice.title} ${st.notice.text}`.trimEnd() : ''
      return ok(`${st.name} (id ${st.id}), created ${when(st.createdAt)}, ${st.members.length}/${st.maxMembers} members:\n${members.join('\n')}${notice}`, st)
    }
    case 'rename': {
      if (args.length !== 3) return usage
      const g = guilds.guildNamed(a)
      if (!g) return no(`No guild named ${a}.`)
      const old = g.name
      const err = guilds.gmRename(g, b)
      if (err) return no(err)
      return ok(`Renamed ${old} to ${g.name}.`)
    }
    case 'disband': {
      if (args.length !== 2) return usage
      const g = guilds.guildNamed(a)
      if (!g) return no(`No guild named ${a}.`)
      guilds.disband(g, Date.now(), null)
      return ok(`Disbanded ${g.name} (${g.members.size} member${g.members.size === 1 ? '' : 's'}).`)
    }
    case 'kick': {
      if (args.length !== 3) return usage
      const g = guilds.guildNamed(a)
      if (!g) return no(`No guild named ${a}.`)
      const rec = [...g.members.values()].find((m) => m.name.toLowerCase() === b.replace(/^@/, '').toLowerCase())
      if (!rec) return no(`${b} is not in ${g.name}.`)
      const wasMaster = rec.characterId === g.master
      const alone = g.members.size === 1
      guilds.gmKick(g, rec.characterId)
      if (alone) return ok(`Expelled ${rec.name}; ${g.name} had no members left and was disbanded.`)
      const next = wasMaster ? g.members.get(g.master)?.name : null
      return ok(`Expelled ${rec.name} from ${g.name}.${next ? ` ${next} is the Guild Master now.` : ''}`)
    }
  }
  return usage
}
