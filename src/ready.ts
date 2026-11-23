import { createHash } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { fingerprint } from './archive.js'
import type { ArchivedMessage } from './types.js'

/**
 * A ledger the background worker prepared. Only the worker writes it, always
 * whole (write + rename); a compaction adopts it when the branch still starts
 * with exactly the rows it covers, and never writes it.
 */
export type ReadyLedger = {
  ledger: string
  /** Branch rows the ledger covers: rows[0..through). */
  through: number
  /**
   * Hash of those rows' fingerprints and archive seqs: a rewind or replacement
   * invalidates it, and so does a compaction that numbered the rows differently
   * from the snapshot the worker planned on (its citations would point wrong).
   */
  prefixHash: string
  /** Incremental updates since its last full rebuild. */
  age: number
  preparedAt: string
}

const READY_FILE = 'ready-ledger.json'
const LOCK_FILE = 'prepare.lock'
/** A lock older than this belongs to a worker that died without cleaning up. */
const STALE_LOCK_MS = 15 * 60 * 1000

export function prefixHash(rows: ArchivedMessage[], through: number): string {
  const hash = createHash('sha256')
  for (const m of rows.slice(0, through)) hash.update(`${m.seq}:${fingerprint(m)}`)
  return hash.digest('base64url')
}

export function readReady(dir: string): ReadyLedger | undefined {
  const path = join(dir, READY_FILE)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReadyLedger> | null
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.ledger !== 'string' ||
      typeof parsed.through !== 'number' ||
      typeof parsed.prefixHash !== 'string' ||
      typeof parsed.age !== 'number'
    ) {
      return undefined
    }
    return parsed as ReadyLedger
  } catch {
    return undefined
  }
}

export function writeReady(dir: string, ready: ReadyLedger): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, READY_FILE)
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(ready))
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** The ready ledger if it still describes the start of this branch. */
export function compatibleReady(dir: string, rows: ArchivedMessage[]): ReadyLedger | undefined {
  const ready = readReady(dir)
  if (!ready || ready.through > rows.length) return undefined
  return prefixHash(rows, ready.through) === ready.prefixHash ? ready : undefined
}

function createExclusiveLock(path: string, token: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, token)
  } finally {
    closeSync(fd)
  }
  return true
}

function makeRelease(path: string, token: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      // Only remove the lock file if it still holds our token (guards against
      // deleting a newer lock acquired after a stale-lock timeout).
      if (readFileSync(path, 'utf-8') === token) rmSync(path, { force: true })
    } catch {
      // Already gone or replaced.
    }
  }
}

/**
 * One exclusive lock per session (default `prepare.lock`), reclaimed when stale.
 * Avoids `existsSync`/`statSync` TOCTOU races by attempting exclusive creation
 * first and verifying ownership via a unique lock token on release.
 */
export function tryLock(dir: string, lockFile = LOCK_FILE, staleMs = STALE_LOCK_MS): (() => void) | undefined {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, lockFile)
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`

  if (createExclusiveLock(path, token)) return makeRelease(path, token)

  // Existing lock: inspect without throwing on concurrent removal.
  let mtimeMs: number
  let ownerToken: string | undefined
  try {
    mtimeMs = statSync(path).mtimeMs
    ownerToken = readFileSync(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createExclusiveLock(path, token) ? makeRelease(path, token) : undefined
    }
    return undefined
  }

  if (Date.now() - mtimeMs <= staleMs) return undefined

  // Reclaim stale lock only if it still holds the same stale token.
  try {
    if (readFileSync(path, 'utf-8') === ownerToken && statSync(path).mtimeMs === mtimeMs) {
      rmSync(path, { force: true })
    }
  } catch {
    // Another worker already cleaned it up.
  }

  return createExclusiveLock(path, token) ? makeRelease(path, token) : undefined
}

export type AcquireLockOptions = {
  waitMs?: number
  pollMs?: number
  staleMs?: number
}

/** Acquire a lock, retrying briefly when another process holds it. */
export async function acquireLock(dir: string, lockFile: string, options: AcquireLockOptions = {}): Promise<() => void> {
  const waitMs = options.waitMs ?? 5_000
  const pollMs = options.pollMs ?? 25
  const staleMs = options.staleMs ?? 5 * 60 * 1000
  const deadline = Date.now() + waitMs
  while (true) {
    const release = tryLock(dir, lockFile, staleMs)
    if (release) return release
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lockFile}`)
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}
