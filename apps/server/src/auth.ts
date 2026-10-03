import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/** Session lifetime. */
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
/** Live sessions kept per account; older ones are revoked when a new one is issued. */
export const MAX_SESSIONS_PER_ACCOUNT = 10

/**
 * scrypt cost: N = 2^15, r = 8, p = 1 (32 MiB, ~50-100 ms per hash on a small mini PC). Parameters
 * are stored with each hash, so raising them later only affects new or re-set passwords.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 64 }
const SCRYPT_MAXMEM = 128 * 1024 * 1024
/** Refuse stored parameters needing more than SCRYPT_MAXMEM (a corrupt row must not allocate gigabytes). */
const MAX_STORED_N = 1 << 17

/** At most this many scrypt computations run at once; more wait in a bounded queue. */
const MAX_CONCURRENT_HASHES = 4
const MAX_QUEUED_HASHES = 32

/** Thrown when too many password hashes are pending (login/register flood). */
export class HashBusyError extends Error {
  constructor() {
    super('password hashing queue is full')
  }
}

let activeHashes = 0
const hashQueue: (() => void)[] = []

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeHashes >= MAX_CONCURRENT_HASHES) {
    if (hashQueue.length >= MAX_QUEUED_HASHES) throw new HashBusyError()
    await new Promise<void>((resolve) => hashQueue.push(resolve))
  } else activeHashes++
  try {
    return await fn()
  } finally {
    const next = hashQueue.shift()
    if (next) next()
    else activeHashes--
  }
}

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return withHashSlot(
    () =>
      new Promise((resolve, reject) => {
        // NFC so the same password typed on different systems (composed vs decomposed accents) matches.
        scrypt(password.normalize('NFC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)))
      }),
  )
}

/** Returns `scrypt$N$r$p$<salt b64>$<hash b64>` with a fresh 16-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const { N, r, p, keyLen } = SCRYPT
  const key = await scryptAsync(password, salt, keyLen, { N, r, p, maxmem: SCRYPT_MAXMEM })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`
}

const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`

/**
 * Constant-time verify. Pass `null` for an unknown user: the same scrypt work is done against a
 * dummy hash so response time does not reveal whether the account exists.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  let parts = (stored ?? DUMMY_HASH).split('$')
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  const sane =
    parts.length === 6 && parts[0] === 'scrypt' && Number.isInteger(N) && N > 1 && N <= MAX_STORED_N && (N & (N - 1)) === 0 &&
    Number.isInteger(r) && r >= 1 && r <= 32 && 128 * N * r <= SCRYPT_MAXMEM && Number.isInteger(p) && p >= 1 && p <= 16
  // A malformed stored hash still costs a full hash, then fails.
  if (!sane) parts = DUMMY_HASH.split('$')
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (expected.length < 16) return false
  const key = await scryptAsync(password, salt, expected.length, {
    N: sane ? N : SCRYPT.N,
    r: sane ? r : SCRYPT.r,
    p: sane ? p : SCRYPT.p,
    maxmem: SCRYPT_MAXMEM,
  })
  return timingSafeEqual(key, expected) && stored !== null && sane
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Fixed-window failure counter (e.g. login failures per IP+username). */
export class FailureLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h) return false
    if (now >= h.resetAt) {
      this.hits.delete(key)
      return false
    }
    return h.count >= this.max
  }

  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key)
    if (!h || now >= h.resetAt) this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
    else h.count++
    if (this.hits.size > 50_000) this.sweep(now)
  }

  /** Takes back one counted attempt (used when an attempt counted up front turns out to succeed). */
  forgive(key: string): void {
    const h = this.hits.get(key)
    if (h && --h.count <= 0) this.hits.delete(key)
  }

  reset(key: string): void {
    this.hits.delete(key)
  }

  sweep(now = Date.now()): void {
    for (const [k, h] of this.hits) if (now >= h.resetAt) this.hits.delete(k)
  }
}

/** Token bucket: `rate` tokens per second, up to `burst`. */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    readonly rate: number,
    readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst
    this.last = now
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate)
    this.last = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
