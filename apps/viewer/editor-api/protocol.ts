/**
 * The World Editor's local API: the wire contract between the editor page (WE-U, `apps/viewer/src/editor/**`) and
 * the API plugin (WE-A, this folder), environment-neutral (no node:*). docs/WORLD_EDITOR.md §2.2, §3.4, §3.5;
 * docs/WAVE_PLAN8.md §2.5, §6.2 (lane WE-A).
 *
 * Every request carries the session token (`TOKEN_HEADER`); the API also checks the Host and Origin (127.0.0.1 on the
 * editor's port) and refuses cross-site fetches. Writes also carry the tab's lease (`LEASE_HEADER`): one editor tab
 * writes at a time, a second tab is read-only (D4).
 *
 * Routes (all under `API_PREFIX`):
 *   POST session     { lease?, force? }                 -> SessionInfo (claims or renews the writer lease)
 *   POST heartbeat   { lease }                          -> { ok, readOnly }
 *   GET  status                                         -> EditorStatus (GPU lock / convert lock banners)
 *   GET  files                                          -> { files: LayerFileInfo[] }
 *   GET  layer?path=height/171_97.png                   -> the layer's raw pixels (little-endian), 404 when absent
 *   GET  json?name=placements.json                      -> the JSON layer file, 404 when absent
 *   POST save        SaveRequest                        -> SaveResult (layers + journal, temp + fsync + rename)
 *   GET  journal                                        -> JournalState
 *   GET  patch?id=17                                    -> the change's patch bytes (./patch.ts)
 *   POST journal/reset { lease }                        -> JournalState (history cleared; the layers stay)
 *   GET  load                                           -> EditorLoad (every layer, the JSON layers, the page's records)
 *
 * Step 2 (Publish, Test in game, Deploy; docs/WORLD_EDITOR.md §2.4, §6; ./publish.ts, ./test-game.ts, ./deploy.ts):
 *   GET  publish                                        -> PublishState (the open or last publish, the job running)
 *   POST publish/start   {}                             -> PublishState (checks + staging convert + report; ≈ 1-2 min)
 *   POST publish/keep    { n }                          -> PublishState (swap into the live export, commit content/)
 *   POST publish/discard { n }                          -> PublishState (Go back: the staging export goes)
 *   POST publish/undo    { n }                          -> PublishState (the kept publish's files copied back)
 *   GET  publish/report?n=3                             -> PublishRecord (with the checks' report)
 *   GET  publish/page?n=3                               -> report.html (show it in an iframe, srcdoc)
 *   POST publish/shot    { n, name, png }               -> { ok } (a before / after image the page rendered)
 *   GET  test                                           -> TestGameState
 *   POST test/start      {}                             -> TestGameState (private server + game on the staging export)
 *   POST test/stop       {}                             -> TestGameState
 *   GET  deploy                                         -> DeployState (the plan: may it go, and the sentence why not)
 *   POST deploy/run      { confirm: true }              -> DeployState (the user's click: the assets-only deploy)
 *
 * Save takes two forms: the API's own (`files: SaveFile[]`, `journal: JournalUpdate` with binary patches, ./patch.ts)
 * and the page form WE-U's session builds (`layers: PageLayerFile[]`, `files: { 'edits.json', 'placements.json' }`,
 * `journal: <every change record, oldest first>`); both land in the same files.
 */
import { WE_GRASS, WE_GRID, WE_TILES, type WorldEditLayerKind } from '../../../packages/shared/src/world-edits/types.ts'

export const API_PREFIX = '/__editor/api/'
export const TOKEN_HEADER = 'x-sro-editor-token'
export const LEASE_HEADER = 'x-sro-editor-lease'
/** The URL parameter that carries the token into the page (the page moves it to sessionStorage and strips it). */
export const TOKEN_PARAM = 'k'

/** The editor's port (D3, §F11: 5190 is texpipe's review server) and host. */
export const EDITOR_PORT = 5185
export const EDITOR_HOST = '127.0.0.1'
export const DEFAULT_EDITOR_WORLD = 'jangan-fields'

/** A tab that misses heartbeats this long loses the writer lease; the page beats every LEASE_BEAT_MS. */
export const LEASE_TTL_MS = 15_000
export const LEASE_BEAT_MS = 5_000

/**
 * The journal's cap (D17): beyond it the oldest applied changes fold into the saved state. The bytes stay under
 * MAX_BODY_BYTES (the page sends its records with every Save and folds at its own 64 MB: history.ts; H-12 DL-3).
 */
export const JOURNAL_MAX_CHANGES = 2_000
export const JOURNAL_MAX_BYTES = 96 * 1024 * 1024
export const JOURNAL_FORMAT = 'sro-editor-journal'
export const JOURNAL_VERSION = 1

/** The largest request body the API reads (a save of many regions, base64). */
export const MAX_BODY_BYTES = 128 * 1024 * 1024

export type LayerKind = WorldEditLayerKind

/** The pixel layout of each layer kind's PNG (docs/WORLD_EDITOR.md §3.1; packages/shared world-edits codecs). */
export const LAYER_FORMATS: Readonly<Record<LayerKind, { width: number; height: number; channels: 1 | 2 | 4; depth: 8 | 16 }>> = {
  height: { width: WE_GRID, height: WE_GRID, channels: 2, depth: 16 },
  paint: { width: WE_GRID, height: WE_GRID, channels: 4, depth: 8 },
  grass: { width: WE_GRASS, height: WE_GRASS, channels: 4, depth: 8 },
  walk: { width: WE_TILES, height: WE_TILES, channels: 1, depth: 8 },
}

/** The JSON layer files the API reads and writes (relative to the world's edits folder). */
export const JSON_LAYER_FILES = ['edits.json', 'placements.json', 'water.json', 'lights.json', 'zones.json', 'probes.json', 'palette.json'] as const
export type JsonLayerFile = (typeof JSON_LAYER_FILES)[number]

const LAYER_PATH = /^(height|paint|grass|walk)\/(\d{1,3})_(\d{1,3})\.png$/

/** `height/171_97.png` -> { kind, x, z }, or null for anything else (no other path is a layer file). */
export function parseLayerPath(path: string): { kind: LayerKind; x: number; z: number } | null {
  const m = LAYER_PATH.exec(path)
  if (!m) return null
  const x = Number(m[2])
  const z = Number(m[3])
  if (x > 255 || z > 255 || String(x) !== m[2] || String(z) !== m[3]) return null
  return { kind: m[1] as LayerKind, x, z }
}

export const isJsonLayerFile = (name: string): name is JsonLayerFile => (JSON_LAYER_FILES as readonly string[]).includes(name)

/** Number of values in a layer's pixel array (Uint16 for height, Uint8 otherwise). */
export const layerValueCount = (kind: LayerKind) => {
  const f = LAYER_FORMATS[kind]
  return f.width * f.height * f.channels
}

/** True when the pixels hold no edit (every texel untouched / auto): the API removes the file instead of writing it. */
export function layerPixelsEmpty(kind: LayerKind, px: ArrayLike<number>): boolean {
  const ch = LAYER_FORMATS[kind].channels
  if (kind === 'walk') {
    for (let i = 0; i < px.length; i++) if (px[i]) return false
    return true
  }
  // height: A (channel 1) = touched; paint and grass: A (channel 3) = touched.
  for (let i = ch - 1; i < px.length; i += ch) if (px[i]) return false
  return true
}

// --- messages -----------------------------------------------------------------------------------------------------

export interface EditorStatus {
  /** The GPU lock's owner line (work/tools/gpu.lock/owner) when another job holds it: show the banner, render on demand. */
  gpuLock: string | null
  /** The convert lock's owner line (work/out/.convert.lock/owner) while a convert runs. */
  convertLock: string | null
}

export interface SessionInfo {
  world: string
  /** True when this tab may not write: another tab holds the lease, or another editor process holds the lock. */
  readOnly: boolean
  /** A plain sentence for the read-only banner. */
  reason?: string
  /** A plain sentence to show once: this editor took over the lock a killed or crashed editor left (DL-5). */
  notice?: string
  /** The writer lease (send it as LEASE_HEADER and in heartbeats); absent when read-only. */
  lease?: string
  leaseTtlMs: number
  beatMs: number
  /** Layer files present (relative paths). */
  files: string[]
  journal: JournalState
  /** False when the layer files differ from what the last save recorded (an interrupted save, git, another tool). */
  consistent: boolean
  /** The files that differ (relative paths). */
  mismatched: string[]
  status: EditorStatus
}

export interface LayerFileInfo {
  path: string
  bytes: number
  sha256: string
}

/** One user action (D16): a stroke, a move, a paste, a delete, a revert... */
export interface JournalEntry {
  /** Increasing, never reused; at least JournalState.nextId when appended. */
  id: number
  /** ISO time; the API stamps it when absent. */
  time?: string
  /** Plain English for the Changes panel: "Raised the ground at 171,97". */
  label: string
  /** The tool's name: 'raise', 'move', 'paint', 'revert', ... */
  tool: string
  /** Region ids (z << 8 | x) the change touched. */
  regions: number[]
  /** Patch size in bytes (the API sets it). */
  bytes?: number
  /** For a revert-one: the change it reverts. */
  revertOf?: number
  /** Changes this one builds on (a move of a pasted object): reverting those asks first. */
  dependsOn?: number[]
  /** The camera when the change was made (position xyz, target xyz), for Publish's before / after views. */
  view?: number[]
  starred?: boolean
  /** Page-form journals: the record's state ('done', 'undone', 'reverted') and the SHA-256 of its stored JSON. */
  state?: string
  hash?: string
  /** True when the patch file holds the page's change record (JSON) rather than a ./patch.ts patch. */
  record?: boolean
}

export interface JournalState {
  /** Entries [0, head) are applied, [head, n) can be redone. */
  head: number
  /** Changes folded into the saved state (the cap, or a reset): no longer undoable one by one. */
  folded: number
  nextId: number
  entries: JournalEntry[]
  /** Total patch bytes kept. */
  bytes: number
}

export interface SaveFile {
  /** A layer path (`height/171_97.png`) or a JSON layer name (`placements.json`). */
  path: string
  /** Layer pixels, base64 of the little-endian values (LAYER_FORMATS); all-untouched pixels remove the file. */
  pixels?: string
  /** A JSON layer's content. */
  json?: unknown
  /** Remove the file. */
  remove?: boolean
}

export interface JournalUpdate {
  /** Drop every stored entry with a larger id first (a new change after undo truncates the redo tail). */
  dropAfterId?: number | null
  /** New changes, each with its patch (base64 of ./patch.ts bytes). */
  append?: Array<{ entry: JournalEntry; patch: string }>
  /** The applied count after this update. */
  head: number
}

export interface SaveRequest {
  files?: SaveFile[]
  journal?: JournalUpdate
}

/** A layer file in the page form: the codecs' pixels (row 0 = north), base64 little-endian; null pixels remove it. */
export interface PageLayerFile {
  kind: LayerKind
  x: number
  z: number
  width: number
  height: number
  channels: 1 | 2 | 4
  depth: 8 | 16
  pixels: string | null
}

/** A change record in the page form: any JSON object with at least an id (increasing), label and regions. */
export type PageChangeRecord = Record<string, unknown> & { id: number; label?: string; regions?: number[]; at?: string; state?: string }

/** The page form of a save (WE-U's EditSession.buildSave()). */
export interface PageSaveRequest {
  world?: string
  files?: Partial<Record<JsonLayerFile, unknown>>
  layers?: PageLayerFile[]
  journal?: PageChangeRecord[]
}

/** GET load: what the page needs to resume (WE-U's EditSession.load()). */
export interface EditorLoad {
  world: string
  files: Partial<Record<JsonLayerFile, unknown>>
  layers: PageLayerFile[]
  /** The page's change records, oldest first (page-form journals only). */
  journal: PageChangeRecord[]
  state: JournalState
}

export interface SaveResult {
  ok: true
  written: string[]
  removed: string[]
  /** The shared validators' problems (Save never refuses for them; Publish does). */
  warnings: string[]
  journal: JournalState
}

export interface ApiError {
  ok: false
  error: string
}

// --- base64 (both environments: btoa / atob exist in browsers and Node) --------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A layer's pixels as little-endian bytes (Uint16 for height). */
export function pixelsToBytes(px: Uint8Array | Uint16Array): Uint8Array {
  if (px instanceof Uint8Array) return px
  const out = new Uint8Array(px.length * 2)
  for (let i = 0; i < px.length; i++) {
    out[i * 2] = px[i]! & 0xff
    out[i * 2 + 1] = px[i]! >> 8
  }
  return out
}

/** Little-endian bytes -> the kind's pixel array; null when the length is wrong. */
export function bytesToPixels(kind: LayerKind, bytes: Uint8Array): Uint8Array | Uint16Array | null {
  const n = layerValueCount(kind)
  if (LAYER_FORMATS[kind].depth === 8) return bytes.length === n ? bytes : null
  if (bytes.length !== n * 2) return null
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) out[i] = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8)
  return out
}

// --- step 2: Publish, Test in game, Deploy (docs/WORLD_EDITOR.md §2.4, §6) -------------------------------------------

/** Where a publish is. `ready`: the staging export and the report wait for Keep or Go back. */
export type PublishPhase = 'preparing' | 'ready' | 'stopped' | 'failed' | 'keeping' | 'kept' | 'discarded' | 'undone'

export type PublishStepStatus = 'wait' | 'run' | 'done' | 'fail' | 'skip'

/** One row of the progress list (validate, convert, base, optimize, checks, tests, report; keep: swap, textures, commit). */
export interface PublishStep {
  key: string
  title: string
  status: PublishStepStatus
  ms?: number
  note?: string
}

/** A camera the page renders before and after (a change's `view`, starred first). */
export interface PublishView {
  /** The change id (0: the overview at 400 m). */
  id: number
  label: string
  view: number[]
  starred?: boolean
}

/** One publish (`work/editor/<world>/publish-<n>/record.json`). */
export interface PublishRecord {
  format: 'sro-editor-publish'
  version: 1
  n: number
  world: string
  phase: PublishPhase
  startedAt: string
  finishedAt?: string
  steps: PublishStep[]
  /** The plain sentence of the banner ("Ready: 2 warnings. Keep or go back."). */
  sentence: string
  /** The checks' verdict (WE-N's report); absent until they ran. */
  verdict?: 'pass' | 'warn' | 'stop'
  /** The changes in words (the journal's labels since the last kept publish). */
  changes: string[]
  /** The journal id the publish covers up to (the next publish lists the changes after it). */
  journalId: number
  /** The staging convert's regions (ids z << 8 | x). */
  regions?: { core: number[]; ring: number[]; nav: number[] }
  /** Export-relative files changed / removed in work/out/world/<world>/; out-relative files of work/out-opt/. */
  files?: { out: string[]; outRemoved: string[]; opt: string[]; optRemoved: string[] }
  /** Terrain tiles painted past 0.1 % cover that are not hero yet: `texpipe hero <tile> on` at Keep (D7, D19). */
  hero?: Array<{ tile: string; cover: number }>
  /** Outputs outside the work set that differ from the live export with no edit there (a stale export). */
  drift?: string[]
  /** The tests run (step 6): pass / fail and the files. */
  tests?: { ok: boolean; files: string[]; summary: string }
  views?: PublishView[]
  /** Before / after images the page sent (file names under shots/). */
  shots?: string[]
  /** The commit Keep made of content/ (short hash), or why none. */
  commit?: string
  /** SHA-256 of the live manifest when the staging export was made (Keep refuses when the map changed since). */
  liveManifest?: string
  /** SHA-256 of every file of the layer folder this publish validated and converted (Keep refuses when they changed: PS-1). */
  layerHashes?: Record<string, string>
  /** The journal ids not in effect (undone, reverted) when this publish was built (the next one compares: DL-7). */
  notApplied?: number[]
  /** The files Keep swapped (also in swap.json): Undo's list even when swap.json could not be written (PS-2). */
  swap?: Array<{ tree: 'out' | 'opt' | 'base'; rel: string; had: boolean; remove?: boolean }>
  /** SHA-256 of each swapped live file right after the swap ('' for a removed one): Undo refuses when they changed (DL-6). */
  afterSwap?: Record<string, string>
  /** Kept, but published.json could not be written yet: the next publish job adds it (PS-2). */
  pendingIndex?: boolean
  /**
   * The process that prepares it (written by the prepare job): a record left "preparing" by a process that is gone
   * (killed, out of memory) is failed by the API, so the page and Deploy never wait on it (V-12).
   */
  pid?: number
  error?: string
}

export interface PublishState {
  /** The newest publish (open, or the last one). */
  current: PublishRecord | null
  /** The newest kept publish (Undo applies only to it). */
  lastKept: number | null
  /** A job (prepare, keep, discard, undo) is running in its own process. */
  running: { job: 'prepare' | 'keep' | 'discard' | 'undo'; n: number; since: string } | null
  /** The convert lock's owner while a convert runs (Publish waits for it). */
  convertLock: string | null
}

export type TestGamePhase = 'off' | 'starting' | 'running' | 'stopping' | 'failed'

export interface TestGameState {
  phase: TestGamePhase
  /** The game's address on this PC (the private game Vite). */
  url?: string
  serverPort?: number
  gamePort?: number
  /** The staging export it plays. */
  world?: string
  /** Where the edit is (glTF metres of the export): the GM may `/goto` there. */
  at?: { x: number; z: number }
  sentence: string
  since?: string
  error?: string
}

/** The Deploy hand-off (§6.1, D36, §F16): may the map edits go to the friends' server now, and if not, why. */
export interface DeployState {
  ok: boolean
  /** Why not (plain English), or the confirmation question. */
  sentence: string
  /** The kept publishes since the last deploy (their changes in words). */
  changes: string[]
  /** The deployed release's commit when it could be read. */
  deployed?: string | null
  /** A deploy is running / finished in this editor session. */
  run?: { phase: 'running' | 'done' | 'failed'; since: string; log: string[]; code?: number }
}

export const PUBLISH_FORMAT = 'sro-editor-publish'
/** Tiles painted past this share of the map get their hero maps (D19). */
export const HERO_COVER = 0.001
