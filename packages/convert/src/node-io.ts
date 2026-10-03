import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Pk2Archive, type ByteSource } from '@sro/formats'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

export interface SroConfig {
  clientDir: string
  pk2Key: string
  workDir: string
  /**
   * Blender executable (sro.config.json `blenderExe`; docs/WAVE_PLAN6.md D19): used by ./blender.ts for the coast's
   * Blender round trip and the movement clips. Absent: the Blender 5.2 default install (blender.ts defaultBlenderExe()).
   */
  blenderExe?: string
}

export function loadConfig(): SroConfig {
  const path = join(REPO_ROOT, 'sro.config.json')
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Copy sro.config.example.json to sro.config.json and set clientDir.`)
  }
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<SroConfig>
  if (!cfg.clientDir) throw new Error('sro.config.json: clientDir is required')
  if (cfg.blenderExe !== undefined && typeof cfg.blenderExe !== 'string') throw new Error('sro.config.json: blenderExe must be a string')
  return {
    clientDir: cfg.clientDir,
    pk2Key: cfg.pk2Key ?? '169841',
    workDir: resolve(REPO_ROOT, cfg.workDir ?? 'work'),
    ...(cfg.blenderExe ? { blenderExe: cfg.blenderExe } : {}),
  }
}

/** Positional reads from a file descriptor; archives can be several GB so we never load them whole. */
export class FileSource implements ByteSource {
  readonly size: number
  private readonly fd: number

  constructor(readonly path: string) {
    this.fd = openSync(path, 'r')
    this.size = fstatSync(this.fd).size
  }

  read(offset: number, length: number): Uint8Array {
    const buf = Buffer.allocUnsafe(length)
    let done = 0
    while (done < length) {
      const n = readSync(this.fd, buf, done, length - done, offset + done)
      if (n === 0) throw new RangeError(`${this.path}: unexpected EOF at ${offset + done}`)
      done += n
    }
    return buf
  }

  close(): void {
    closeSync(this.fd)
  }
}

export const ARCHIVES = ['Data', 'Map', 'Media', 'Music', 'Particles'] as const
export type ArchiveName = (typeof ARCHIVES)[number]

const openArchives = new Map<string, Pk2Archive>()

export function openArchive(name: ArchiveName, cfg: SroConfig = loadConfig()): Pk2Archive {
  let archive = openArchives.get(name)
  if (!archive) {
    archive = Pk2Archive.open(new FileSource(join(cfg.clientDir, `${name}.pk2`)), cfg.pk2Key)
    openArchives.set(name, archive)
  }
  return archive
}
