/**
 * World feature of lane ED-C, the GM content editors (docs/QUESTS.md §5; WAVE_PLAN §5.2). Adds three tabs to the GM
 * window (gm/window.ts `registerGmTab`, shown only to gm/admin accounts since only they get a GM window):
 * - Spawns (gm/editors/spawns.ts): nests near you with live ground rings, add / change / move / remove / undo;
 * - NPCs (gm/editors/npcs.ts): place a new NPC, rename, shop, move, face, remove / restore, undo;
 * - Quests (gm/editors/quest-editor.ts): the quest list and the Quest Editor window over /api/gm/quests.
 * `contentChanged` refreshes the open editors. The editors use EDITOR_ROLE (default gm) through the server's existing
 * role checks and never change roles (decision 48); a player never sees any of it.
 */
import { injectEditorStyles } from '../../gm/editors/style.ts'
import { GmQuestApi } from '../../gm/editors/api.ts'
import { npcIdentity } from '../../gm/editors/commands.ts'
import { NestRings } from '../../gm/editors/nest-rings.ts'
import { NpcsTab } from '../../gm/editors/npcs.ts'
import { QuestEditorWindow, QuestsTab } from '../../gm/editors/quest-editor.ts'
import { SpawnsTab } from '../../gm/editors/spawns.ts'
import { registerGmTab, type GmHost } from '../../gm/window.ts'
import { t } from '../../i18n/index.ts'
import type { WorldFeatureFactory } from '../features.ts'

export const editorsFeature: WorldFeatureFactory = ctx => {
  const content = () => ctx.app.catalog.content
  const offline = ctx.app.transport.mock
  const api = new GmQuestApi(() => ctx.app.token)
  const spawns = new Set<SpawnsTab>()
  const npcs = new Set<NpcsTab>()
  const questTabs = new Set<QuestsTab>()
  let editor: QuestEditorWindow | null = null

  const selfY = (): number | undefined => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)?.pos.y
  }
  const groundY = (x: number, z: number): number => {
    const y = selfY()
    const w = ctx.world()
    return w ? w.heightAt(x, z, y) : (y ?? 0)
  }
  const target = () => ctx.target()?.state ?? null
  const targetNpc = (): string | null => {
    const s = target()
    return s && s.kind === 'npc' ? npcIdentity(s) : null
  }

  const questEditor = (host: GmHost): QuestEditorWindow => {
    editor ??= new QuestEditorWindow({
      art: ctx.app.art,
      parent: host.parent,
      api,
      content: () => content(),
      selfPos: () => host.selfPos(),
      selfName: () => host.selfName(),
      targetNpc,
      offline,
    })
    return editor
  }

  const offs = [
    registerGmTab({
      id: 'spawns',
      label: t('gm.editor.tab.spawns'),
      make: tabApi => {
        injectEditorStyles()
        const tab = new SpawnsTab(tabApi, {
          mobs: () => content().mobs,
          makeRings: () => new NestRings(ctx.scene, groundY, tabApi.host.parent, t('gm.editor.nest.offLabel')),
          targetMob: () => {
            const s = target()
            return s && s.kind === 'mob' ? s.model : null
          },
        })
        spawns.add(tab)
        const dispose = tab.dispose.bind(tab)
        tab.dispose = () => {
          spawns.delete(tab)
          dispose()
        }
        return tab
      },
    }),
    registerGmTab({
      id: 'npcs',
      label: t('gm.editor.tab.npcs'),
      make: tabApi => {
        injectEditorStyles()
        const tab = new NpcsTab(tabApi, { npcs: () => content().npcs, shops: () => content().shops, targetNpc })
        npcs.add(tab)
        const dispose = tab.dispose.bind(tab)
        tab.dispose = () => {
          npcs.delete(tab)
          dispose()
        }
        return tab
      },
    }),
    registerGmTab({
      id: 'quests',
      label: t('gm.editor.tab.quests'),
      make: tabApi => {
        injectEditorStyles()
        const tab = new QuestsTab(tabApi, { open: id => questEditor(tabApi.host).open(id), close: () => editor?.close() }, api, offline)
        questTabs.add(tab)
        const dispose = tab.dispose.bind(tab)
        tab.dispose = () => {
          questTabs.delete(tab)
          dispose()
        }
        return tab
      },
    }),
  ]

  return {
    onMessage(msg) {
      if (msg.t !== 'contentChanged') return
      if (msg.kind === 'nests') for (const s of spawns) s.contentChanged()
      if (msg.kind === 'npcs') for (const n of npcs) n.contentChanged()
      if (msg.kind === 'quests') {
        for (const q of questTabs) q.contentChanged()
        editor?.contentChanged(msg.kind)
      }
    },
    onFrame() {
      for (const s of spawns) s.frame()
    },
    escape() {
      if (!editor?.isOpen) return false
      editor.close()
      return true
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      editor?.dispose()
      editor = null
    },
  }
}
