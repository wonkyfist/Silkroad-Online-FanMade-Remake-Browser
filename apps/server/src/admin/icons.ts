import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ItemDef } from '@sro/shared'
import type { GameContext } from '../game.ts'

/**
 * Icon URLs for the admin panel (docs/ADMIN.md §2): the converted item icons (OUT_DIR/icons/index.json, as the game's
 * HUD reads them, else ItemDef.icon) and the target window's rank icons for monsters (retail has no per-monster
 * portrait: only `targetwindow/tw_icon_<rank>`). Served by game.ts at /admin/out/<path> from OUT_DIR, else OUT_OPT_DIR,
 * so they work in development (no /out/ on the game server) and on the mini PC alike.
 */

export const ADMIN_ICON_PREFIX = '/admin/out/'
/** The only /admin/out/ paths game.ts serves: converted icons and the target window's rank icons. */
export const ADMIN_ICON_PATH = /^(?!.*\.\.)(icon|icons)\/[a-z0-9_/.-]+\.png$|^ui\/targetwindow\/tw_icon_[a-z]+\.png$/

/** Monster rank -> target window icon (the client's targetwindow/tw_icon_<variant>). */
const RANK_ICON: Record<string, string> = { normal: 'normal', champion: 'champion', giant: 'giant', elite: 'elite', strongElite: 'elite', unique: 'unique', titan: 'titan' }

interface Icons {
  roots: string[]
  index: Record<string, string> | null
  exists: Map<string, boolean>
}

const STATE = new WeakMap<GameContext, Icons>()

function state(ctx: GameContext): Icons {
  let s = STATE.get(ctx)
  if (s) return s
  const roots = [ctx.config.outDir, ctx.config.outOptDir ?? join(dirname(ctx.config.outDir), 'out-opt')]
  let index: Record<string, string> | null = null
  for (const root of roots) {
    try {
      const j = JSON.parse(readFileSync(join(root, 'icons', 'index.json'), 'utf8')) as { items?: Record<string, unknown> }
      if (j.items && typeof j.items === 'object') {
        index = {}
        for (const [k, v] of Object.entries(j.items)) if (typeof v === 'string') index[k] = v
        break
      }
    } catch {
      // no icon export there
    }
  }
  STATE.set(ctx, (s = { roots, index, exists: new Map() }))
  return s
}

/** The admin URL of a converted file (relative to OUT_DIR), or null when neither tree has it. */
function url(s: Icons, rel: string): string | null {
  const clean = rel.replace(/^\/?(out|out-opt)\//, '').replace(/^\//, '')
  if (!ADMIN_ICON_PATH.test(clean)) return null
  let ok = s.exists.get(clean)
  if (ok === undefined) {
    ok = s.roots.some((r) => existsSync(join(r, clean)))
    s.exists.set(clean, ok)
  }
  return ok ? `${ADMIN_ICON_PREFIX}${clean}` : null
}

/** An item's icon URL: the icon export first (like the game HUD), then ItemDef.icon; null when none exists. */
export function itemIcon(ctx: GameContext, code: string, def: ItemDef | undefined = ctx.data.item(code)): string | null {
  const s = state(ctx)
  const fromIndex = s.index?.[code]
  return (fromIndex ? url(s, fromIndex) : null) ?? (def?.icon ? url(s, def.icon) : null)
}

/** A monster's icon: its rank's target window icon (retail has no per-monster portrait). */
export function mobIcon(ctx: GameContext, code: string): string | null {
  const rank = RANK_ICON[ctx.data.mob(code)?.rarity ?? 'normal'] ?? 'normal'
  return url(state(ctx), `ui/targetwindow/tw_icon_${rank}.png`)
}

/** The roots /admin/out/ serves from (OUT_DIR, then OUT_OPT_DIR). */
export function iconRoots(ctx: GameContext): string[] {
  return state(ctx).roots
}
