/**
 * Mock support of lane PT-C (party) for ?mock=1 (docs/WAVE_PLAN.md §3.3). Optional and first to cut: the real-server
 * e2e tests are the truth. Only that lane edits this file. Import MockServer types with `import type`. Until it is
 * filled, party requests get the built-in `not_implemented` answer.
 */
import type { MockExtension } from '../mock.ts'

export const partyMock: MockExtension = {}
