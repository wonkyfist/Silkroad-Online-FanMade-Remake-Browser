/**
 * PK2 ("JoyMax File Manager") archive reader.
 *
 * Layout (SilkroadDoc JMXPACK, Veykril/pk2):
 *   header   256 bytes: signature[30] "JoyMax File Manager!\n", version u32, encrypted u8,
 *                       check[16] = Blowfish("Joymax Pak File\0"), reserved[205]
 *   blocks   2560 bytes = 20 entries x 128 bytes, root block at offset 256.
 *   entry    type u8 (0 empty, 1 folder, 2 file), name[81] (EUC-KR, NUL padded),
 *            access/create/modify FILETIME u64 x3, position u64, size u32,
 *            nextBlock u64 (meaningful on the 20th entry: next block of the same folder), pad[2]
 * Only the entry blocks are encrypted (Blowfish, little-endian words); file data is stored raw.
 */
import { BinaryReader, eucKr } from './binary.ts'
import { Blowfish } from './blowfish.ts'

export const PK2_SIGNATURE = 'JoyMax File Manager!\n'
export const PK2_SALT = Uint8Array.of(0x03, 0xf8, 0xe4, 0x44, 0x88, 0x99, 0x3f, 0x64, 0xfe, 0x35)
export const PK2_DEFAULT_KEY = '169841'
const HEADER_SIZE = 256
const ENTRY_SIZE = 128
const ENTRIES_PER_BLOCK = 20
const BLOCK_SIZE = ENTRY_SIZE * ENTRIES_PER_BLOCK
const CHECK_PLAINTEXT = 'Joymax Pak File\0'

/** Random-access byte source, so the reader works over a Node file handle or an in-memory/browser buffer. */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Uint8Array
}

export class BufferSource implements ByteSource {
  constructor(private readonly bytes: Uint8Array) {}
  get size(): number {
    return this.bytes.byteLength
  }
  read(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, offset + length)
  }
}

export interface Pk2Header {
  signature: string
  version: number
  encrypted: boolean
  check: Uint8Array
}

export interface Pk2File {
  /** Original-case path with '/' separators, e.g. "res/char/chinaman/chinaman_adventurer.bsr" */
  path: string
  offset: number
  size: number
  /** Last-modified time (ms since epoch), 0 if unset. */
  modified: number
}

/** Derive the Blowfish key from the ASCII PK2 password: password bytes XOR the fixed salt. */
export function derivePk2Key(password: string, salt: Uint8Array = PK2_SALT): Uint8Array {
  const len = Math.min(password.length, 56)
  const key = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const c = password.charCodeAt(i)
    if (c > 0x7f) throw new RangeError('PK2 password must be ASCII')
    key[i] = c ^ (i < salt.length ? salt[i]! : 0)
  }
  return key
}

/** The 16-byte header check value a given key produces (readers compare the first 3 bytes). */
export function pk2CheckBytes(blowfish: Blowfish): Uint8Array {
  const check = new TextEncoder().encode(CHECK_PLAINTEXT)
  blowfish.encryptJoymax(check)
  return check
}

export function readPk2Header(bytes: Uint8Array): Pk2Header {
  const r = new BinaryReader(bytes)
  const signature = r.fixedString(30)
  const version = r.u32()
  const encrypted = r.u8() !== 0
  const check = r.bytesView(16).slice()
  return { signature, version, encrypted, check }
}

export function normalizePk2Path(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
}

function filetimeToMs(filetime: bigint): number {
  return filetime === 0n ? 0 : Number(filetime / 10_000n) - 11_644_473_600_000
}

export class Pk2Archive {
  /** Normalized (lowercase, '/') path -> file. */
  readonly files = new Map<string, Pk2File>()
  /** Normalized folder paths ('' is the root). */
  readonly folders = new Set<string>([''])
  readonly warnings: string[] = []

  private constructor(
    readonly source: ByteSource,
    readonly header: Pk2Header,
    private readonly blowfish: Blowfish | undefined,
  ) {}

  static open(source: ByteSource, password: string = PK2_DEFAULT_KEY, salt: Uint8Array = PK2_SALT): Pk2Archive {
    if (source.size < HEADER_SIZE) throw new Error(`not a PK2 archive: only ${source.size} bytes`)
    const header = readPk2Header(source.read(0, HEADER_SIZE).slice())
    if (header.signature !== PK2_SIGNATURE) {
      throw new Error(`not a PK2 archive: signature ${JSON.stringify(header.signature)}`)
    }
    let blowfish: Blowfish | undefined
    if (header.encrypted) {
      blowfish = new Blowfish(derivePk2Key(password, salt))
      const expected = pk2CheckBytes(blowfish)
      for (let i = 0; i < 3; i++) {
        if (expected[i] !== header.check[i]) {
          throw new Error('PK2 key/salt mismatch: header check bytes do not match (wrong password or salt)')
        }
      }
    }
    const archive = new Pk2Archive(source, header, blowfish)
    archive.index()
    return archive
  }

  private readBlock(offset: number): Uint8Array {
    if (offset + BLOCK_SIZE > this.source.size) {
      throw new RangeError(`block at ${offset} runs past end of archive (${this.source.size})`)
    }
    const block = this.source.read(offset, BLOCK_SIZE).slice()
    this.blowfish?.decryptJoymax(block)
    return block
  }

  private index(): void {
    const visited = new Set<number>()
    const stack: Array<{ offset: number; dir: string }> = [{ offset: HEADER_SIZE, dir: '' }]
    while (stack.length > 0) {
      const { offset: firstBlock, dir } = stack.pop()!
      let blockOffset = firstBlock
      while (blockOffset !== 0) {
        if (visited.has(blockOffset)) {
          this.warnings.push(`block ${blockOffset} (${dir || '/'}) visited twice; stopping chain`)
          break
        }
        visited.add(blockOffset)
        let block: Uint8Array
        try {
          block = this.readBlock(blockOffset)
        } catch (e) {
          this.warnings.push(`${dir || '/'}: ${(e as Error).message}`)
          break
        }
        const r = new BinaryReader(block)
        let next = 0
        for (let i = 0; i < ENTRIES_PER_BLOCK; i++) {
          r.seek(i * ENTRY_SIZE)
          const type = r.u8()
          const name = r.fixedString(81, eucKr)
          r.skip(8 + 8) // access, create
          const modified = r.u64big()
          const position = r.u64()
          const size = r.u32()
          const nextBlock = r.u64()
          if (i === ENTRIES_PER_BLOCK - 1) next = nextBlock
          if (type === 0 || name === '.' || name === '..' || name === '') continue
          const path = dir ? `${dir}/${name}` : name
          if (type === 1) {
            this.folders.add(normalizePk2Path(path))
            stack.push({ offset: position, dir: path })
          } else if (type === 2) {
            this.files.set(normalizePk2Path(path), { path, offset: position, size, modified: filetimeToMs(modified) })
          } else {
            this.warnings.push(`${path}: unknown entry type ${type}`)
          }
        }
        blockOffset = next
      }
    }
  }

  get(path: string): Pk2File | undefined {
    return this.files.get(normalizePk2Path(path))
  }

  has(path: string): boolean {
    return this.files.has(normalizePk2Path(path))
  }

  /** Read a file's bytes. Throws if missing. */
  read(fileOrPath: Pk2File | string): Uint8Array {
    const file = typeof fileOrPath === 'string' ? this.get(fileOrPath) : fileOrPath
    if (!file) throw new Error(`PK2: no such file ${String(fileOrPath)}`)
    if (file.offset + file.size > this.source.size) {
      throw new RangeError(`PK2: ${file.path} data (${file.offset}+${file.size}) runs past end of archive`)
    }
    return this.source.read(file.offset, file.size)
  }

  /** Files directly inside (or, with recursive, anywhere under) a folder. */
  list(folder: string, recursive = false): Pk2File[] {
    const prefix = normalizePk2Path(folder)
    const out: Pk2File[] = []
    for (const [key, file] of this.files) {
      if (prefix && !key.startsWith(prefix + '/')) continue
      const rest = prefix ? key.slice(prefix.length + 1) : key
      if (!recursive && rest.includes('/')) continue
      out.push(file)
    }
    return out
  }
}
