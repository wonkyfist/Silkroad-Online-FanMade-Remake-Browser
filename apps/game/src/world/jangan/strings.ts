/** Loading-screen text of the world stages (the English table's world.stage.* keys). */
import type { WorldLoadStage } from '@sro/world-render'
import { t, type StringKey } from '../../i18n/index.ts'

const STAGE: Record<WorldLoadStage, StringKey> = {
  manifest: 'world.stage.manifest',
  regions: 'world.stage.regions',
  navigation: 'world.stage.navigation',
  tiles: 'world.stage.tiles',
  terrain: 'world.stage.terrain',
  water: 'world.stage.water',
  objects: 'world.stage.objects',
  done: 'world.stage.done',
}

export function stageText(stage: WorldLoadStage, done: number, total: number): string {
  return t(STAGE[stage], { done, total })
}
