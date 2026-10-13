/**
 * The GM window's Toolbox tab (gm/toolbox.ts): one-click GM actions, favourites, recent commands and autocomplete.
 * Only gm/admin accounts get a GM window, so a player never sees it; the server checks the role of every command.
 */
import { ToolboxTab } from '../../gm/toolbox.ts'
import { registerGmTab } from '../../gm/window.ts'
import { t } from '../../i18n/index.ts'
import type { WorldFeatureFactory } from '../features.ts'

export const gmToolboxFeature: WorldFeatureFactory = ctx => {
  const content = () => ctx.app.catalog.content
  const off = registerGmTab({
    id: 'toolbox',
    label: t('gm.tools.tab'),
    make: api => new ToolboxTab(api, { items: () => content().items.values(), mobs: () => content().mobs.values() }),
  })
  return {
    dispose() {
      off()
    },
  }
}
