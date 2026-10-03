/**
 * Encoding for the sound export (docs/SOUND.md §3): trimmed PCM -> Ogg Opus through an external ffmpeg (no npm
 * dependency), or trimmed 16-bit mono PCM WAV when ffmpeg is missing. Also the incremental cache
 * (work/out/sound/.cache.json). Node only.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** `bin` (or $SRO_FFMPEG, else 'ffmpeg') when `<bin> -version` runs, else null. */
export function detectFfmpeg(bin?: string): string | null {
  const cand = bin ?? process.env.SRO_FFMPEG ?? 'ffmpeg'
  try {
    const r = spawnSync(cand, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    if (r.status !== 0 || !/ffmpeg version/i.test(r.stdout ?? '')) return null
    return cand
  } catch {
    return null
  }
}

/** True when the ffmpeg build lists the libopus encoder. */
export function hasLibopus(ffmpeg: string): boolean {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  return r.status === 0 && /libopus/.test(r.stdout ?? '')
}

/** The §3 command: `ffmpeg -v error -y -i <in.wav> -ac <n> -c:a libopus -b:a <kbps>k -vbr on -application audio <out.ogg>`. */
export function opusArgs(input: string, output: string, kbps: number, channels: number): string[] {
  return ['-v', 'error', '-y', '-i', input, '-ac', String(channels), '-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-application', 'audio', output]
}

export function encodeOpus(ffmpeg: string, input: string, output: string, kbps: number, channels: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, opusArgs(input, output, kbps, channels), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => (err += String(d)))
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(0, 400)}`))))
  })
}

/** Runs `jobs` with at most `limit` in flight. */
export async function pool<T>(items: readonly T[], limit: number, run: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      await run(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

export interface CacheEntry {
  size: number
  mtimeMs: number
  sha1: string
  /** kbps for opus, 0 for wav. */
  bitrate: number
  codec: 'opus' | 'wav'
  /** Output path relative to the sound folder ('player/mvwalkgrass.ogg'). */
  out: string
  ms: number
  channels: 1 | 2
}

export type SoundCache = Record<string, CacheEntry>

export function readCache(path: string): SoundCache {
  if (!existsSync(path)) return {}
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SoundCache) : {}
  } catch {
    return {}
  }
}
