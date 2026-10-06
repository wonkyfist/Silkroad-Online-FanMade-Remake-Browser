/**
 * GameAudio: the game's sound effects facade (docs/SOUND.md §5). One per page, created in main.ts, reachable as
 * `app.audio` and, for code without an App (hud/window.ts), through the module accessor `gameAudio()`.
 *
 * - Buses master -> sfx / ui / ambient on WebAudio (backend.ts); music stays a streamed <audio> (music.ts).
 * - Volumes and the master mute live in AudioSettings (settings.ts); the tab going to the background suspends
 *   everything when `muteHidden` is on.
 * - Files load lazily through SoundBank (bank.ts); a sound whose buffer is not decoded when it fires is skipped
 *   (UI cues wait up to 150 ms). A missing index or file never breaks anything: the game just plays quieter.
 * - Every start goes through VoicePolicy (voices.ts): caps per bus, per file and per entity, steal order, distance.
 *
 * Nothing here runs at import time, so modules that only import the accessor stay DOM-free in tests.
 */
import { WEATHER_CUES, type AreaSound, type ItemDef, type SoundCategory, type SoundCue, type SoundIndex, type SoundSurface } from '@sro/shared'
import { AmbientPlayer, type AmbientOutput } from './ambient.ts'
import { WebAudioBackend, type AudioBackend, type Vec3Like, type VoiceHandle } from './backend.ts'
import { SoundBank, type BankOptions } from './bank.ts'
import { dropCue, equipKind, hitSound, pick, type HitQuery } from './cues.ts'
import { EntitySound, type EntityPlay, type EntitySoundHost, type SoundView } from './entity.ts'
import { Music } from './music.ts'
import { AudioSettings, browserStorage } from './settings.ts'
import { SurfaceProbe, type SurfaceWorld } from './surface.ts'
import { wavBytes, type Pcm } from './synth.ts'
import { VoicePolicy, type ActiveVoice, type VoiceBus, type VoiceKind } from './voices.ts'
import { WeatherAudio } from './weather.ts'
import { snowSurface } from './winter.ts'
import { LightningAudio } from './lightning.ts'

export { AudioSettings } from './settings.ts'
export { Music } from './music.ts'
export type { SoundView } from './entity.ts'
export { EntitySound } from './entity.ts'
export type { SurfaceWorld } from './surface.ts'
export { WeatherAudio } from './weather.ts'

/** UI cues wait this long for their buffer before they are dropped (ms). */
const UI_WAIT_MS = 150
/** Height of the listener above the own character's feet (metres). */
export const LISTENER_HEIGHT_M = 1.6
/** Level of the ambient loop bed on the ambient bus. */
const AMBIENT_LOOP_GAIN = 0.7

/** Footstep files preloaded at world enter: walk/run on the Jangan surfaces (Dirt, Stone, Grass, Mud/Water). */
const PRELOAD_SURFACES: readonly SoundSurface[] = ['Dirt', 'Stone', 'Grass', 'Mud']
// H11 S4: the unique appear / defeat cues too (29 + 20 KB): with a 3–6 h respawn the first notice is often the only one.
const PRELOAD_CUES = ['ui.click', 'ui.click2', 'ui.windowOpen', 'ui.windowClose', 'ui.error', 'ui.levelUp', 'item.pickup', 'item.dropGold', 'hit.crit', 'ui.potion', 'ui.uniqueAppear', 'ui.uniqueDown']
/**
 * docs/SOUND.md §10: cues of the world that answer one action each, loaded at world enter so the first one is not
 * dropped while its file still loads (an accessory's first equip used to be lost that way): every `item.equip.<KIND>`
 * (about 25 small files, ~70 KB), the rare/elixir drops, quests, revival and the Berserk orb.
 */
const WORLD_PRELOAD_CUES = ['item.dropRare', 'item.dropElixir', 'ui.questOpen', 'ui.questDone', 'ui.revive', 'ui.hyan']
const WORLD_PRELOAD_PREFIX = 'item.equip.'
/** An item put into a slot waits this long for its sound's buffer (ms): it answers a click, a late "ding" still fits. */
const PLACE_WAIT_MS = 600

export interface PlayOptions {
  /** Spatial position (glTF metres); omitted = non-spatial (yourself, the interface). */
  pos?: Vec3Like
  /** A long sound follows this position every frame (null = stop following). */
  follow?: () => Vec3Like | null
  entity?: number
  kind?: VoiceKind
  /** Default: 0 for others, 3 when `self`. */
  priority?: number
  self?: boolean
  bus?: VoiceBus
  gain?: number
  pan?: number
  /** Wait this long for the buffer instead of dropping at once (ms). */
  waitMs?: number
  /** Skip when the same entity is already playing this file (a skill stage and its clip track naming one sound). */
  unique?: boolean
  /** Playback rate (1 = as recorded; Berserk's roar plays a retail shout pitched down). */
  rate?: number
}

interface Voice extends ActiveVoice {
  handle: VoiceHandle
  follow?: () => Vec3Like | null
}

export interface GameAudioDeps {
  backend: AudioBackend
  settings: AudioSettings
  music?: Music | null
  bank?: SoundBank
  bankOptions?: Omit<BankOptions, 'decode'>
  /** Item lookup for equip sounds. */
  itemDef?: (code: string) => ItemDef | undefined
  rng?: () => number
  /** Wall clock (ms) for the voice policy. */
  clock?: () => number
  debug?: boolean
}

const busOf = (c: SoundCategory | undefined): VoiceBus => (c === 'ui' ? 'ui' : c === 'ambient' ? 'ambient' : 'sfx')

export class GameAudio implements EntitySoundHost {
  readonly settings: AudioSettings
  readonly music: Music | null
  readonly bank: SoundBank
  readonly ambient: AmbientPlayer
  /** Rain, wind and thunder (audio/weather.ts); the weather feature drives it every frame. */
  readonly weather: WeatherAudio
  /** Lightning's synthesized crackle and close crack (audio/lightning.ts); the lightning feature drives it. */
  readonly lightning: LightningAudio
  private readonly backend: AudioBackend
  private readonly policy = new VoicePolicy()
  private readonly probe = new SurfaceProbe()
  private voices: Voice[] = []
  private serial = 0
  private listener: Vec3Like | null = null
  private selfId = -1
  private targetId = -1
  private world: SurfaceWorld | null = null
  private wantedArea: string | null = null
  private hidden = false
  private readonly random: () => number
  private readonly clock: () => number
  private readonly itemDef: (code: string) => ItemDef | undefined
  readonly debug: boolean
  private readonly offs: Array<() => void> = []

  /** The browser build: WebAudio, localStorage settings, the /out/sound index. `muted` = ?mute=1. */
  static create(opts: { muted?: boolean; itemDef?: (code: string) => ItemDef | undefined } = {}): GameAudio {
    const settings = new AudioSettings(browserStorage(), !!opts.muted)
    const music = new Music({ muted: settings.muted, volume: settings.get().master * settings.get().music })
    const backend = new WebAudioBackend()
    const audio = new GameAudio({
      backend,
      settings,
      music,
      itemDef: opts.itemDef,
      bankOptions: { preferWav: !canPlayOpus() },
      debug: /[?&]sounddebug=(1|true)/.test(location.search),
    })
    audio.attachBrowser(backend)
    void audio.bank.loadIndex().then(index => {
      if (!index) return
      audio.preloadCues(PRELOAD_CUES)
      if (audio.wantedArea) audio.setArea(audio.wantedArea)
    })
    const w = window as unknown as { __sroAudio?: unknown }
    w.__sroAudio = audio.debugInfo()
    return audio
  }

  constructor(deps: GameAudioDeps) {
    this.backend = deps.backend
    this.settings = deps.settings
    this.music = deps.music ?? null
    this.bank = deps.bank ?? new SoundBank({ ...deps.bankOptions, decode: bytes => this.backend.decode(bytes) })
    this.random = deps.rng ?? Math.random
    this.clock = deps.clock ?? (() => performance.now())
    this.itemDef = deps.itemDef ?? (() => undefined)
    this.debug = !!deps.debug
    const out: AmbientOutput = {
      now: () => this.backend.now(),
      loop: (file, fadeS) => this.startLoop(file, fadeS),
      oneShot: (file, gain, pan) => this.playFile(file, { bus: 'ambient', kind: 'other', gain, pan, self: true, priority: 0 }),
      // Wave 10 (GL-O): a flock's flush sounds at the flock (ambient.ts flush).
      oneShotAt: (file, gain, pos) => this.playFile(file, { bus: 'ambient', kind: 'other', gain, pos, priority: 0 }),
    }
    this.ambient = new AmbientPlayer(out, this.random)
    this.weather = new WeatherAudio({
      ready: () => this.backend.ready && !this.hidden,
      now: () => this.backend.now(),
      cue: name => this.weatherCue(name),
      buffer: file => {
        const b = this.bank.get(file)
        if (!b && this.index) void this.bank.load(file)
        return b
      },
      start: (buffer, opts) => this.backend.start(buffer, opts),
      retain: file => this.bank.retain(file),
      release: file => this.bank.release(file),
      oneShot: (file, gain, pan, waitMs) => this.playFile(file, { bus: 'ambient', kind: 'other', gain, pan, self: true, priority: 2, waitMs }),
      muteBirds: on => this.ambient.mute('weather', on),
      rng: () => this.random(),
    })
    this.lightning = new LightningAudio({
      ready: () => this.backend.ready && !this.hidden && !this.settings.muted,
      decode: bytes => this.backend.decode(bytes),
      start: (buffer, opts) => this.backend.start(buffer, opts),
    })
    this.applySettings()
    this.offs.push(this.settings.onChange(() => this.applySettings()))
  }

  get index(): SoundIndex | null {
    return this.bank.index
  }

  /**
   * A weather cue: the code's (shared WEATHER_CUES) whenever the index has all its files, so a reassignment among the
   * exported weather files needs no re-export (W9F A5); else the exported index's.
   */
  private weatherCue(name: string): Readonly<SoundCue> | undefined {
    const index = this.index
    const own = WEATHER_CUES[name]
    if (own && index && own.files.every(f => index.files[f])) return own
    return index?.cues[name]
  }

  rng(): number {
    return this.random()
  }

  // ---- browser wiring ---------------------------------------------------------------------------

  /** Unlock on the first gesture (capture, so it runs before the click it belongs to) and the hidden-tab mute. */
  private attachBrowser(backend: WebAudioBackend): void {
    // Every gesture tries again until the context really runs (some keys are not a user activation).
    let applied = false
    const unlock = () => {
      if (!backend.unlock()) return
      if (!applied) this.applySettings()
      applied = true
      if (!backend.ready) return
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)
    const onVisibility = () => this.setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    this.offs.push(() => {
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
      document.removeEventListener('visibilitychange', onVisibility)
    })
  }

  /** The tab went to the background (or came back): suspend everything while `muteHidden` is on. */
  setHidden(hidden: boolean): void {
    const mute = hidden && this.settings.get().muteHidden
    if (mute === this.hidden) return
    this.hidden = mute
    if (mute) {
      this.backend.suspend()
      this.music?.setPaused(true)
    } else {
      this.backend.resume()
      this.music?.setPaused(false)
    }
  }

  private applySettings(): void {
    const s = this.settings.get()
    const muted = this.settings.muted
    this.backend.setBusGain('master', muted ? 0 : s.master)
    this.backend.setBusGain('sfx', s.sfx)
    this.backend.setBusGain('ui', s.ui)
    this.backend.setBusGain('ambient', s.ambient * this.muffle)
    this.music?.setMuted(muted)
    this.music?.setVolume(s.master * s.music)
    if (this.hidden && !s.muteHidden) this.setHidden(false)
  }

  // ---- playing ------------------------------------------------------------------------------------

  /** An interface cue ('ui.click', 'ui.windowOpen', 'ui.error'...): non-spatial, waits briefly for its buffer. */
  ui(cue: string): void {
    this.play(cue, { self: true, waitMs: UI_WAIT_MS })
  }

  /** A logical cue of the index (one of its files at random, at the cue's gain and on its category's bus). */
  play(cue: string, opts: PlayOptions = {}): void {
    const c = this.index?.cues[cue]
    const file = pick(c?.files, this.random)
    if (!c || !file) return this.log(`cue ${cue}: none`)
    this.playFile(file, { bus: busOf(c.category), ...opts, gain: c.gain * (opts.gain ?? 1) })
  }

  /** Plays one file (a SoundIndex.files id) if the voice policy admits it. */
  playFile(file: string, opts: PlayOptions | EntityPlay = {}): void {
    try {
      this.startFile(file, opts as PlayOptions)
    } catch (err) {
      console.error('[audio] play failed', file, err)
    }
  }

  private startFile(file: string, o: PlayOptions): void {
    if (this.hidden || this.settings.muted || !this.index) return
    const bus = o.bus ?? 'sfx'
    const level = this.settings.get()
    if (level.master <= 0 || level[bus] <= 0) return
    if (o.unique && o.entity !== undefined && this.voices.some(v => v.entity === o.entity && v.file === file)) return
    const buffer = this.bank.get(file)
    if (!buffer || !this.backend.ready) {
      if (o.waitMs && o.waitMs > 0) this.startSoon(file, o)
      else {
        if (!buffer) void this.bank.load(file)
        this.log(`${file}: ${buffer ? 'audio not running' : 'not loaded'}`)
      }
      return
    }
    const self = !!o.self || !o.pos
    const distance = o.pos ? this.distance(o.pos) : 0
    const now = this.clock()
    const req = {
      bus,
      file,
      kind: o.kind ?? 'other',
      entity: o.entity,
      priority: o.priority ?? (self ? 3 : 0),
      distance,
      self,
    }
    const admit = this.policy.admit(req, this.voices, now)
    if (!admit.ok) return this.log(`${file}: ${admit.reason} d=${distance.toFixed(1)}m`)
    for (const id of admit.steal) this.stopVoice(id)
    const gain = Math.max(0, (o.gain ?? 1) * (0.9 + 0.1 * this.random()))
    const id = ++this.serial
    this.bank.retain(file)
    const handle = this.backend.start(buffer, { bus, gain, pos: o.pos, pan: o.pan, ...(o.rate && o.rate !== 1 ? { rate: o.rate } : {}), onEnded: () => this.removeVoice(id) })
    if (!handle) {
      this.bank.release(file)
      return
    }
    this.voices.push({ ...req, id, startedAt: now, handle, follow: buffer.duration > 0.5 ? o.follow : undefined })
    this.log(`${file} ${bus}${o.entity !== undefined ? ` #${o.entity}` : ''} d=${distance.toFixed(1)}m`)
  }

  /**
   * UI cues wait briefly: the first click of the page creates the audio context (it starts a moment later) and
   * may find its buffer still decoding.
   */
  private startSoon(file: string, o: PlayOptions): void {
    const deadline = this.clock() + (o.waitMs ?? 0)
    let tries = 0
    const attempt = () => {
      if (this.clock() > deadline || ++tries > 12) return this.log(`${file}: too late`)
      if (this.backend.ready && this.bank.get(file)) return this.startFile(file, { ...o, waitMs: 0 })
      setTimeout(attempt, 20)
    }
    void this.bank.load(file).then(attempt)
  }

  private startLoop(file: string, fadeS: number): { stop(fadeS: number): void } | null {
    if (!this.backend.ready) return null
    const buffer = this.bank.get(file)
    if (!buffer) {
      void this.bank.load(file)
      return null
    }
    const id = ++this.serial
    this.bank.retain(file)
    const handle = this.backend.start(buffer, { bus: 'ambient', gain: AMBIENT_LOOP_GAIN, loop: true, fadeIn: fadeS, onEnded: () => this.removeVoice(id) })
    if (!handle) {
      this.bank.release(file)
      return null
    }
    this.voices.push({ id, bus: 'ambient', file, kind: 'other', priority: 3, distance: 0, self: true, loop: true, startedAt: this.clock(), handle })
    return { stop: s => handle.stop(s) }
  }

  /**
   * Wave 10 (docs/COAST.md §10.1, lane CST-A): a looped positional voice on the ambient bus (audio/coast.ts, the surf
   * emitters); null when it cannot start yet (no context, a hidden tab, not in the index, still loading).
   */
  loopAt(file: string, o: { pos: Vec3Like; gain: number; fadeS: number; offset?: number }): VoiceHandle | null {
    if (!this.backend.ready || this.hidden || !this.index?.files[file]) return null
    const buffer = this.bank.get(file)
    if (!buffer) {
      void this.bank.load(file)
      return null
    }
    const id = ++this.serial
    this.bank.retain(file)
    const handle = this.backend.start(buffer, { bus: 'ambient', gain: o.gain, loop: true, pos: o.pos, fadeIn: o.fadeS, offset: o.offset, onEnded: () => this.removeVoice(id) })
    if (!handle) {
      this.bank.release(file)
      return null
    }
    this.voices.push({ id, bus: 'ambient', file, kind: 'other', priority: 3, distance: 0, self: true, loop: true, startedAt: this.clock(), handle })
    return handle
  }

  private stopVoice(id: number): void {
    const v = this.voices.find(x => x.id === id)
    if (!v) return
    v.handle.stop(0.03)
    this.removeVoice(id)
  }

  private removeVoice(id: number): void {
    const i = this.voices.findIndex(x => x.id === id)
    if (i < 0) return
    const [v] = this.voices.splice(i, 1)
    this.bank.release(v!.file)
  }

  // ---- game events ----------------------------------------------------------------------------------

  /** Impact of one hit on its victim (§2.6), plus a player victim's pained cry on a crit. */
  hit(q: HitQuery, at: { entity: number; pos?: Vec3Like; self: boolean; priority: number }): void {
    const index = this.index
    if (!index) return
    const s = hitSound(index, { ...q, rng: this.random })
    const pos = at.self ? undefined : at.pos
    // The impact counts against the victim's 2 sfx; the layers (crit, imbue, shield) do not, so none steals another.
    for (const [i, file] of (s?.files ?? []).entries()) {
      this.playFile(file, { ...(i === 0 ? { entity: at.entity } : {}), kind: 'other', pos, self: at.self, priority: at.priority, gain: s!.gain })
    }
    if (q.outcome === 'crit' && (q.victim.kind === 'player' || q.victim.kind === 'mob')) {
      // VOC_MOAN CRITYCAL; the victim's hurt-clip moan that follows becomes the same file (EntitySound.critHit).
      const set = q.victim.kind === 'mob' ? index.mobs[q.victim.model] : index.voices[q.victim.model]
      const cry = pick(set?.moan.crit, this.random)
      if (cry) this.playFile(cry, { entity: at.entity, kind: 'voice', pos, self: at.self, priority: at.priority })
    }
  }

  /** Equip sound of the first of `codes` that is now worn (§5.9, `item.equip.<KIND>`). */
  equip(codes: readonly (string | null | undefined)[]): void {
    const code = codes.find(c => !!c)
    if (code) this.place(code)
  }

  /**
   * The sound of item `code` put into a slot (equip, unequip, a bag move; effectsound ITEM SND_EQUIP by item kind,
   * docs/SOUND.md §10.3), else `item.equip.METAL`. Waits PLACE_WAIT_MS for a file still loading.
   */
  place(code: string): void {
    const index = this.index
    if (!index) return
    const kind = equipKind(this.itemDef(code))
    this.play(index.cues[`item.equip.${kind}`] ? `item.equip.${kind}` : 'item.equip.METAL', { self: true, waitMs: PLACE_WAIT_MS })
  }

  /** The drop sound of item `code` at `pos` (gold, Seal of Star, elixirs: `dropCue`); other drops are silent. */
  drop(code: string, pos: Vec3Like): void {
    const cue = dropCue(code, this.itemDef(code))
    if (cue) this.play(cue, { pos, priority: 1 })
  }

  /**
   * A sound made in code (audio/synth.ts) under `id` (`synth/<name>`): rendered and decoded once (the decode waits for
   * the audio context), then kept; `playFile(id, ...)` plays it like any file. Repeated calls do nothing.
   */
  prepareSynth(id: string, make: () => Pcm): void {
    if (this.synthIds.has(id)) return
    this.synthIds.add(id)
    void (async () => {
      try {
        this.bank.adopt(id, await this.backend.decode(wavBytes(make())))
      } catch (err) {
        console.warn('[audio] synth failed', id, err)
      }
    })()
  }

  private readonly synthIds = new Set<string>()

  /** Loads a skill group's sounds (stages, swings, SND_DMG) ahead of use: an imbue's hit layer when it starts. */
  preloadSkill(group: string): void {
    const s = this.index?.skills[group]
    if (!s) return
    const ids: string[] = []
    if (Array.isArray(s.dmg)) ids.push(...s.dmg)
    else if (s.dmg) ids.push(...Object.values(s.dmg.weak), ...Object.values(s.dmg.strong))
    for (const files of Object.values(s.swing ?? {})) ids.push(...files)
    for (const st of s.stages ?? []) for (const f of [st.begin, st.end]) if (f) ids.push(f)
    this.bank.preload(ids)
  }

  /** Stage sound of a skill (skilleffect cols 26/27, §2.3): READY, SHOT, ACT_S... of `group`. */
  skillStage(group: string, phase: string, at: { entity?: number; pos?: Vec3Like; self: boolean; priority?: number }): boolean {
    const stages = this.index?.skills[group]?.stages
    const hit = stages?.find(s => s.phase === phase && s.begin)
    if (!hit?.begin) return false
    this.playFile(hit.begin, { entity: at.entity, kind: 'other', pos: at.self ? undefined : at.pos, self: at.self, priority: at.priority, unique: true })
    return true
  }

  /** Area ambience ('JANGAN_TOWN' / 'JANGAN_FIELD'; null = none). Applied once the index is in. */
  setArea(id: string | null): void {
    this.wantedArea = id
    if (!id) return this.ambient.setArea(null, null)
    const index = this.index
    if (!index) return
    const area = resolveArea(index, id)
    this.ambient.setArea(area?.[0] ?? null, area?.[1] ?? null)
    if (area) this.bank.preload(area[1].day.map(l => l.file))
  }

  // ---- per frame ------------------------------------------------------------------------------------

  /** The own character's feet and the camera's view direction (a forward vector, not ArcRotateCamera.alpha). */
  setListener(feet: Vec3Like, forward: Vec3Like): void {
    const pos = { x: feet.x, y: feet.y + LISTENER_HEIGHT_M, z: feet.z }
    this.listener = pos
    if (this.backend.ready) this.backend.setListener(pos, forward)
  }

  /** The listener's head (null before the first setListener); Siege of Jangan's wall sounds aim from it. */
  get listenerPos(): Vec3Like | null {
    return this.listener
  }

  /** Loads these files now (Siege of Jangan: the walls' sounds once the walls are in view). */
  preloadFiles(ids: readonly string[]): void {
    this.bank.preload(ids)
  }

  /** Who is "you" and "your target" for voice priorities. */
  setFocus(selfId: number, targetId: number): void {
    this.selfId = selfId
    this.targetId = targetId
  }

  /** The loaded world for footstep surfaces (null: flat fallback, all Dirt). */
  setWorld(world: SurfaceWorld | null): void {
    this.world = world
  }

  /** Once per frame: ambient timers and positions of long sounds that follow their entity. */
  tick(): void {
    try {
      this.ambient.tick()
      for (const v of this.voices) {
        if (!v.follow) continue
        const p = v.follow()
        if (p) v.handle.setPosition(p)
        else v.follow = undefined
      }
    } catch (err) {
      console.error('[audio] tick failed', err)
    }
  }

  // ---- EntitySoundHost -------------------------------------------------------------------------------

  distance(p: Vec3Like): number {
    const l = this.listener
    return l ? Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z) : 0
  }

  surfaceAt(x: number, y: number, z: number): SoundSurface {
    // docs/WINTER.md §8.3: snowy ground crunches (the retail snow steps)
    return snowSurface(this.probe.surfaceAt(this.world, x, y, z), this.snowCover)
  }

  /** Winter (docs/WINTER.md §8.3): the snow cover under the footsteps, 0..1. */
  private snowCover = 0
  /** Winter: the ambient bus scale under snow (1 = none). */
  private muffle = 1

  /** The snow cover the footsteps hear (the winter feature, every frame). */
  setSnowCover(cover: number): void {
    this.snowCover = Number.isFinite(cover) ? cover : 0
  }

  /** Muffles the ambient bus by `gain` (0..1; 1 = as set in the options), re-applied only on a real change. */
  setAmbientMuffle(gain: number): void {
    const g = Math.round(Math.min(1, Math.max(0, Number.isFinite(gain) ? gain : 1)) * 50) / 50
    if (g === this.muffle) return
    this.muffle = g
    this.applySettings()
  }

  /** Wave 10 (WAVE_PLAN6 D22, lane MV-C): the loaded world's water level (World.waterLevelAt), for the jump's steps. */
  waterLevelAt(x: number, z: number): number | null {
    try {
      return this.world?.waterLevelAt?.(x, z) ?? null
    } catch {
      return null
    }
  }

  modelTracks(code: string) {
    const m = this.bank.modelNow(code)
    if (m === undefined && this.index) void this.bank.model(code)
    return m
  }

  priorityOf(id: number, kind: SoundView['kind'], self: boolean): number {
    if (self || id === this.selfId) return 3
    if (id === this.targetId) return 2
    return kind === 'player' ? 1 : 0
  }

  // ---- loading ----------------------------------------------------------------------------------------

  /** Sound for one entity view (null for ground items). */
  entity(view: SoundView): EntitySound | null {
    if (view.kind === 'item') return null
    return new EntitySound(this, view)
  }

  /** Clip tracks of a model and every file of its kept clips (`keep`: the clips the models keep), plus mob rows. */
  preloadModel(code: string, keep?: RegExp): void {
    void this.bank.loadIndex().then(index => {
      if (!index) return
      const mob = index.mobs[code]
      if (mob) this.bank.preload([...mob.moan.normal, ...mob.deathVoice, ...mob.deathThud, ...Object.values(mob.attacks).flatMap(a => a.dmg ?? [])])
      if (!index.models[code]) return
      void this.bank.model(code).then(m => {
        if (!m) return
        const files = new Set<string>()
        for (const [clip, tracks] of Object.entries(m.clips)) {
          if (keep && !keep.test(clip)) continue
          for (const t of tracks) files.add(t.file)
        }
        this.bank.preload(files)
      })
    })
  }

  /** World-enter preload (§5.4): footsteps, the hit sets of your weapon family, the common cues. */
  preloadWorld(hitSets: readonly string[] = []): void {
    void this.bank.loadIndex().then(index => {
      if (!index) return
      const ids: (string | undefined)[] = []
      for (const s of PRELOAD_SURFACES) ids.push(...(index.steps.walk[s] ?? []), ...(index.steps.run[s] ?? []))
      for (const k of hitSets) {
        const h = index.hits[k]
        if (h) ids.push(...Object.values(h.weak), ...Object.values(h.strong))
      }
      this.bank.preload(ids)
      this.preloadCues([...PRELOAD_CUES, ...WORLD_PRELOAD_CUES, ...Object.keys(index.cues).filter(k => k.startsWith(WORLD_PRELOAD_PREFIX))])
    })
  }

  private preloadCues(cues: readonly string[]): void {
    const index = this.index
    if (!index) return
    this.bank.preload(cues.flatMap(c => index.cues[c]?.files ?? []))
  }

  // ---- debug ----------------------------------------------------------------------------------------

  private log(text: string): void {
    if (this.debug) console.log(`[sfx] ${this.backend.now().toFixed(3)} ${text}`)
  }

  /** `window.__sroAudio` (§5.13): live counts for the console. */
  debugInfo(): { readonly voices: number; readonly cached: number; readonly bytes: number } {
    const self = this
    return {
      get voices() {
        return self.voices.length
      },
      get cached() {
        return self.bank.stats().cached
      },
      get bytes() {
        return self.bank.stats().bytes
      },
    }
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off()
    this.weather.stop()
    this.lightning.stop()
    this.ambient.stop()
    for (const v of [...this.voices]) this.stopVoice(v.id)
  }
}

/** An area by id, else the first area of the same kind (town/field) the id names. */
export function resolveArea(index: SoundIndex, id: string): [string, AreaSound] | null {
  const direct = index.areas[id]
  if (direct) return [id, direct]
  const kind = /TOWN/i.test(id) ? 'town' : 'field'
  const any = Object.entries(index.areas).find(([, a]) => a.kind === kind)
  return any ?? null
}

function canPlayOpus(): boolean {
  try {
    return new Audio().canPlayType('audio/ogg; codecs=opus') !== ''
  } catch {
    return true
  }
}

let current: GameAudio | null = null

/** The page's GameAudio (null before main.ts sets it, and in tests). */
export function gameAudio(): GameAudio | null {
  return current
}

export function setGameAudio(audio: GameAudio | null): void {
  current = audio
}
