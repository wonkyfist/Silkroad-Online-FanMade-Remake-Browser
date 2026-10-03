/**
 * Mock support of lane QS-C (quests: accept, kill/collect counting on mock kills, turn-in; docs/QUESTS.md §2.8) for
 * ?mock=1 (docs/WAVE_PLAN.md §3.3). Optional and first to cut: the real-server e2e tests are the truth. Only that lane
 * edits this file. Import MockServer types with `import type`. Until it is filled, quest requests get the built-in
 * `not_implemented` answer.
 */
import type { MockExtension } from '../mock.ts'

export const questsMock: MockExtension = {}
