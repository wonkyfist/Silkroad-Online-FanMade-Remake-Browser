/**
 * Minimal RIFF/WAVE handling for the sound export (docs/SOUND.md §3): read the fmt/data chunks of integer PCM
 * (8/16/24/32-bit, plus 32-bit float and WAVE_FORMAT_EXTENSIBLE wrapping either), trim trailing silence, downmix,
 * and write 16-bit PCM. Every other chunk (LIST, cue, bext, JUNK, smpl, ...) is dropped. Node-free.
 */

export interface Pcm {
  sampleRate: number
  /** One Int16Array per channel, same length. */
  channels: Int16Array[]
}

export interface WavInfo {
  format: number
  channels: number
  sampleRate: number
  bits: number
}

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!)

/** Decodes a WAV to 16-bit channels. Throws on anything that is not PCM/float RIFF WAVE. */
export function parseWav(bytes: Uint8Array): Pcm & { info: WavInfo } {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let fmt: WavInfo | null = null
  let data: Uint8Array | null = null
  let o = 12
  while (o + 8 <= bytes.length) {
    const id = tag(bytes, o)
    const size = dv.getUint32(o + 4, true)
    const body = o + 8
    const end = Math.min(bytes.length, body + size)
    if (id === 'fmt ' && size >= 16) {
      let format = dv.getUint16(body, true)
      if (format === 0xfffe && size >= 40) format = dv.getUint16(body + 24, true)
      fmt = { format, channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) }
    } else if (id === 'data') {
      data = bytes.subarray(body, end)
    }
    o = body + size + (size & 1)
  }
  if (!fmt) throw new Error('no fmt chunk')
  if (!data) throw new Error('no data chunk')
  if (fmt.format !== 1 && fmt.format !== 3) throw new Error(`unsupported WAV format tag ${fmt.format}`)
  if (fmt.channels < 1) throw new Error('no channels')
  const bps = fmt.bits / 8
  if (![1, 2, 3, 4].includes(bps) || (fmt.format === 3 && bps !== 4)) throw new Error(`unsupported ${fmt.bits}-bit samples`)
  const frame = bps * fmt.channels
  const n = Math.floor(data.length / frame)
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const channels = Array.from({ length: fmt.channels }, () => new Int16Array(n))
  const clamp = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const p = i * frame + c * bps
      let s: number
      if (fmt.format === 3) s = clamp(Math.round(ddv.getFloat32(p, true) * 32767))
      else if (bps === 1) s = (data[p]! - 128) << 8
      else if (bps === 2) s = ddv.getInt16(p, true)
      else if (bps === 3) s = ((data[p + 2]! << 24) | (data[p + 1]! << 16)) >> 16
      else s = ddv.getInt32(p, true) >> 16
      channels[c]![i] = s
    }
  }
  return { sampleRate: fmt.sampleRate, channels, info: fmt }
}

/**
 * Cuts the samples after the last one above `threshold` (|s| > 32 on 16-bit = -60 dBFS), keeping a `tailMs` tail.
 * Leading silence is never trimmed: clip key times are relative to the sound's start.
 */
export function trimTrailingSilence(pcm: Pcm, threshold = 32, tailMs = 20): Pcm {
  const len = pcm.channels[0]?.length ?? 0
  let last = -1
  for (const ch of pcm.channels) {
    for (let i = len - 1; i > last; i--) {
      if (Math.abs(ch[i]!) > threshold) {
        last = i
        break
      }
    }
  }
  const tail = Math.round((tailMs * pcm.sampleRate) / 1000)
  const end = Math.max(1, Math.min(len, last + 1 + tail))
  if (end >= len) return pcm
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map(ch => ch.slice(0, end)) }
}

/** Averages every channel into one. */
export function downmix(pcm: Pcm): Pcm {
  if (pcm.channels.length <= 1) return pcm
  const len = pcm.channels[0]!.length
  const out = new Int16Array(len)
  const k = pcm.channels.length
  for (let i = 0; i < len; i++) {
    let s = 0
    for (const ch of pcm.channels) s += ch[i]!
    out[i] = Math.round(s / k)
  }
  return { sampleRate: pcm.sampleRate, channels: [out] }
}

/** 16-bit PCM RIFF/WAVE, interleaved, fmt + data chunks only. */
export function writeWav16(pcm: Pcm): Uint8Array {
  const k = pcm.channels.length
  const n = pcm.channels[0]?.length ?? 0
  const dataBytes = n * k * 2
  const out = new Uint8Array(44 + dataBytes)
  const dv = new DataView(out.buffer)
  const str = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i)
  }
  str(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, k, true)
  dv.setUint32(24, pcm.sampleRate, true)
  dv.setUint32(28, pcm.sampleRate * k * 2, true)
  dv.setUint16(32, k * 2, true)
  dv.setUint16(34, 16, true)
  str(36, 'data')
  dv.setUint32(40, dataBytes, true)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k; c++) {
      dv.setInt16(o, pcm.channels[c]![i]!, true)
      o += 2
    }
  }
  return out
}

/** Duration in ms. */
export const pcmMs = (pcm: Pcm): number => Math.round(((pcm.channels[0]?.length ?? 0) * 1000) / pcm.sampleRate)
