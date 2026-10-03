/**
 * The MockServer's default lane mocks (docs/WAVE_PLAN.md §3.3), in order: each sees a message before the built-in
 * handling and may claim it. W3-FC writes the wave-3 lines, W4-FC the wave-4 ones, W8-FC the wave-8 ones, W10-P the
 * jump, W11-P the unique notices; each lane fills only its own file.
 */
import type { MockExtension } from '../mock.ts'
import { fxMock } from './fx.ts'
import { guildMock } from './guild.ts'
import { movementMock } from './movement.ts'
import { npcMock } from './npc.ts'
import { partyMock } from './party.ts'
import { questsMock } from './quests.ts'
import { skillsMock } from './skills.ts'
import { stallMock } from './stall.ts'
import { tradeMock } from './trade.ts'
import { uniquesMock } from './uniques.ts'
import { uxMock } from './ux.ts'

export const DEFAULT_MOCK_EXTENSIONS: readonly MockExtension[] = [
  fxMock, // net/mock/fx.ts (FX-C2): first, so a sitter stands up before another lane claims the request
  skillsMock, // net/mock/skills.ts (SK-C)
  npcMock, // net/mock/npc.ts (NPC-C)
  uxMock, // net/mock/ux.ts (UX-B)
  questsMock, // net/mock/quests.ts (QS-C)
  partyMock, // net/mock/party.ts (PT-C)
  uniquesMock, // net/mock/uniques.ts (W11-P, wave 11): claims only `/unique` chat lines
  movementMock, // net/mock/movement.ts (W10-P, wave 10): claims only `jump`, which no later mock gates
  tradeMock, // net/mock/trade.ts (TR-C, wave 8)
  stallMock, // net/mock/stall.ts (ST-C, wave 8)
  guildMock, // net/mock/guild.ts (GU-C, wave 8)
]
