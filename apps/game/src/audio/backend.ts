/**
 * The one file that touches WebAudio (docs/SOUND.md §5.1-§5.6). Graph:
 *   AudioBufferSourceNode -> GainNode -> [PannerNode | StereoPannerNode] -> bus (sfx | ui | ambient) -> master -> out
 * (a voice started with `filter: true` has a low-pass BiquadFilterNode between the source and its gain).
 * Everything else in src/audio talks to the AudioBackend interface, so it runs in vitest without a browser.
 *
 * The context is created on the first user gesture (browsers refuse to start audio before one); decodes asked for
 * earlier wait for it. Positions are glTF metres in Babylon's left-handed frame; WebAudio's panner is right-handed,
 * so z is negated for sources and the listener alike (§5.6), or left and right would swap.
 */
import type { VoiceBus } from './voices.ts'

export interface Vec3Like {
  x: number
  y: number
  z: number
}

/** A decoded sound. */
export interface SoundBuffer {
  readonly duration: number
  /** Decoded size (float samples), for the cache budget. */
  readonly bytes: number
}

export interface StartOptions {
  bus: VoiceBus
  gain: number
  loop?: boolean
  /** Spatial source position (glTF metres); omitted = non-spatial. */
  pos?: Vec3Like
  /** Non-spatial stereo pan -1..1. */
  pan?: number
  /** Fade in over this many seconds (ambient loops). */
  fadeIn?: number
  /** Playback rate (1 = as recorded; the weather rain bed detunes its two voices by a few percent). */
  rate?: number
  /** Start this many seconds into the buffer (a loop that should not restart on its opening; wrapped to the length). */
  offset?: number
  /** Route the voice through a low-pass filter (open until `setLowpass`), for muffling under shelter. */
  filter?: boolean
  onEnded?: () => void
}

export interface VoiceHandle {
  stop(fadeS?: number): void
  setPosition(p: Vec3Like): void
  /** Ramps the voice gain to `gain` over `rampS` seconds (optional: the weather beds; test fakes may omit it). */
  setGain?(gain: number, rampS: number): void
  /** Ramps the low-pass cut-off (Hz) of a voice started with `filter: true` (no-op without one). */
  setLowpass?(hz: number, rampS: number): void
}

/** The cut-off of an open low-pass filter (Hz): above hearing, so the filter is transparent. */
export const LOWPASS_OPEN_HZ = 20000

export interface AudioBackend {
  /** true while sounds can start: the context exists (after the first gesture) and runs. */
  readonly ready: boolean
  /** Audio clock in seconds (0 before the context exists). */
  now(): number
  decode(bytes: ArrayBuffer): Promise<SoundBuffer>
  start(buffer: SoundBuffer, opts: StartOptions): VoiceHandle | null
  setBusGain(bus: VoiceBus | 'master', gain: number): void
  setListener(pos: Vec3Like, forward: Vec3Like): void
  suspend(): void
  resume(): void
}

/** Distance model of positioned sounds (§5.6): gain = 3 / (3 + 1.2 (d - 3)); the 40 m cut-off is the voice cull. */
export const PANNER = { refDistance: 3, rolloffFactor: 1.2, maxDistance: 10000 } as const

interface WebBuffer extends SoundBuffer {
  readonly buffer: AudioBuffer
}

type Ctor = typeof AudioContext

function audioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

export class WebAudioBackend implements AudioBackend {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly buses = new Map<VoiceBus, GainNode>()
  private readonly gains = new Map<VoiceBus | 'master', number>()
  private readonly waiting: Array<() => void> = []
  private suspended = false

  static supported(): boolean {
    return audioContextCtor() !== null
  }

  /**
   * The context exists and runs. Not while it is suspended (hidden tab, or created by a key that is not a user
   * activation): sources started then would all burst out together on resume.
   */
  get ready(): boolean {
    return this.ctx?.state === 'running'
  }

  /** Creates the context (call from a user gesture). Returns true once it exists. */
  unlock(): boolean {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.suspended) void this.ctx.resume().catch(() => {})
      return true
    }
    const C = audioContextCtor()
    if (!C) return false
    try {
      const ctx = new C({ latencyHint: 'interactive' })
      const master = ctx.createGain()
      master.gain.value = this.gains.get('master') ?? 1
      master.connect(ctx.destination)
      for (const bus of ['sfx', 'ui', 'ambient'] as const) {
        const g = ctx.createGain()
        g.gain.value = this.gains.get(bus) ?? 1
        g.connect(master)
        this.buses.set(bus, g)
      }
      this.ctx = ctx
      this.master = master
      if (this.suspended) void ctx.suspend().catch(() => {})
      else if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    } catch (err) {
      console.warn('[audio] cannot create an AudioContext', err)
      return false
    }
    for (const fn of this.waiting.splice(0)) fn()
    return true
  }

  now(): number {
    return this.ctx?.currentTime ?? 0
  }

  async decode(bytes: ArrayBuffer): Promise<SoundBuffer> {
    if (!this.ctx) await new Promise<void>(resolve => this.waiting.push(resolve))
    const buffer = await this.ctx!.decodeAudioData(bytes)
    const out: WebBuffer = { buffer, duration: buffer.duration, bytes: buffer.length * buffer.numberOfChannels * 4 }
    return out
  }

  start(sound: SoundBuffer, opts: StartOptions): VoiceHandle | null {
    const ctx = this.ctx
    const bus = this.buses.get(opts.bus)
    if (!ctx || !bus || !('buffer' in sound)) return null
    const src = ctx.createBufferSource()
    src.buffer = (sound as WebBuffer).buffer
    src.loop = !!opts.loop
    if (opts.rate && opts.rate > 0 && opts.rate !== 1) src.playbackRate.value = opts.rate
    const gain = ctx.createGain()
    const t = ctx.currentTime
    if (opts.fadeIn && opts.fadeIn > 0) {
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(opts.gain, t + opts.fadeIn)
    } else {
      gain.gain.value = opts.gain
    }
    let filter: BiquadFilterNode | null = null
    if (opts.filter) {
      filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = LOWPASS_OPEN_HZ
      src.connect(filter)
      filter.connect(gain)
    } else {
      src.connect(gain)
    }
    let panner: PannerNode | null = null
    if (opts.pos) {
      panner = ctx.createPanner()
      panner.panningModel = 'equalpower'
      panner.distanceModel = 'inverse'
      panner.refDistance = PANNER.refDistance
      panner.rolloffFactor = PANNER.rolloffFactor
      panner.maxDistance = PANNER.maxDistance
      setPannerPosition(panner, opts.pos)
      gain.connect(panner)
      panner.connect(bus)
    } else if (opts.pan && typeof ctx.createStereoPanner === 'function') {
      const sp = ctx.createStereoPanner()
      sp.pan.value = Math.max(-1, Math.min(1, opts.pan))
      gain.connect(sp)
      sp.connect(bus)
    } else {
      gain.connect(bus)
    }
    let stopped = false
    src.onended = () => {
      src.disconnect()
      filter?.disconnect()
      gain.disconnect()
      panner?.disconnect()
      opts.onEnded?.()
    }
    const offset = opts.offset && opts.offset > 0 && src.buffer ? opts.offset % src.buffer.duration : 0
    src.start(0, offset)
    return {
      stop: (fadeS = 0.03) => {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        try {
          gain.gain.cancelScheduledValues(now)
          gain.gain.setValueAtTime(gain.gain.value, now)
          gain.gain.linearRampToValueAtTime(0, now + fadeS)
          src.stop(now + fadeS + 0.01)
        } catch {
          // already stopped
        }
      },
      setPosition: p => {
        if (panner) setPannerPosition(panner, p)
      },
      setGain: (value, rampS) => {
        if (stopped) return
        rampParam(gain.gain, Math.max(0, value), ctx.currentTime, rampS)
      },
      setLowpass: (hz, rampS) => {
        if (!filter || stopped) return
        rampParam(filter.frequency, Math.min(LOWPASS_OPEN_HZ, Math.max(20, hz)), ctx.currentTime, rampS)
      },
    }
  }

  setBusGain(bus: VoiceBus | 'master', value: number): void {
    this.gains.set(bus, value)
    const node = bus === 'master' ? this.master : this.buses.get(bus)
    if (!node || !this.ctx) return
    node.gain.setTargetAtTime(value, this.ctx.currentTime, 0.03)
  }

  setListener(pos: Vec3Like, forward: Vec3Like): void {
    const l = this.ctx?.listener
    if (!l) return
    const len = Math.hypot(forward.x, forward.z) || 1
    const fx = forward.x / len
    const fz = -forward.z / len
    if (l.positionX) {
      l.positionX.value = pos.x
      l.positionY.value = pos.y
      l.positionZ.value = -pos.z
      l.forwardX.value = fx
      l.forwardY.value = 0
      l.forwardZ.value = fz
      l.upX.value = 0
      l.upY.value = 1
      l.upZ.value = 0
    } else {
      // Firefox: the older setters.
      const legacy = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }
      legacy.setPosition(pos.x, pos.y, -pos.z)
      legacy.setOrientation(fx, 0, fz, 0, 1, 0)
    }
  }

  suspend(): void {
    this.suspended = true
    void this.ctx?.suspend().catch(() => {})
  }

  resume(): void {
    this.suspended = false
    void this.ctx?.resume().catch(() => {})
  }
}

/** Ramps an AudioParam from its current value to `value` over `rampS` seconds (0: at once). */
function rampParam(p: AudioParam, value: number, now: number, rampS: number): void {
  try {
    p.cancelScheduledValues(now)
    p.setValueAtTime(p.value, now)
    if (rampS > 0) p.linearRampToValueAtTime(value, now + rampS)
    else p.setValueAtTime(value, now)
  } catch {
    // a stopped source's params can refuse automation: nothing to do
  }
}

function setPannerPosition(p: PannerNode, pos: Vec3Like): void {
  if (p.positionX) {
    p.positionX.value = pos.x
    p.positionY.value = pos.y
    p.positionZ.value = -pos.z
  } else {
    const legacy = p as unknown as { setPosition(x: number, y: number, z: number): void }
    legacy.setPosition(pos.x, pos.y, -pos.z)
  }
}
